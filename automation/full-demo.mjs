import path from 'node:path';
import {
  backToAi,
  baseUrl,
  createHumanDriver,
  holdUntil,
  openLearningTool,
  pause,
  projectRoot,
  recordFlow,
  sendChat,
  writeSession,
} from './demo-utils.mjs';
import {
  createNaturalDemoUser,
  fallbackLecture,
  fallbackQuestions,
  mainPrompt,
  noteContent,
  noteTitle,
  onboardingAnswers,
  practicePrompt,
} from './demo-data.mjs';

const rehearsal = process.argv.includes('--rehearsal');
const targetSeconds = 420;
const accepted = { min: 390, max: 450 };

function artifactKind(item) {
  return String(item?.type ?? item?.kind ?? '').toLowerCase();
}

async function runFullFlow({ page, context, startedAt }) {
  const human = createHumanDriver(page);
  const markers = [];
  let currentMarker = null;
  const begin = (name) => {
    if (currentMarker) currentMarker.end = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    currentMarker = { name, start: Number(((Date.now() - startedAt) / 1000).toFixed(2)) };
    markers.push(currentMarker);
  };
  const finishMarkers = () => {
    if (currentMarker) currentMarker.end = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    return markers;
  };
  const demoUser = createNaturalDemoUser();

  begin('01_REGISTER');
  await page.goto(`${baseUrl}/register`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('auth-phone').waitFor({ state: 'visible' });
  await pause(2_400);
  await human.type(page.getByTestId('auth-nickname'), demoUser.nickname, { delay: 28 });
  await human.type(page.getByTestId('auth-phone'), demoUser.username, { delay: 34 });
  await human.type(page.getByTestId('auth-password'), demoUser.password, { delay: 32 });
  const registerResponse = page.waitForResponse((response) => response.url().includes('/api/auth/register') && response.request().method() === 'POST', { timeout: 60_000 });
  await human.click(page.getByTestId('auth-submit'), { after: 900 });
  const registered = await registerResponse;
  if (!registered.ok()) throw new Error(`注册失败：${registered.status()} ${await registered.text()}`);
  const registration = (await registered.json()).data;
  const headers = { Authorization: `Bearer ${registration.token}` };
  await writeSession({ username: demoUser.username, password: demoUser.password, userId: registration.user_id, createdAt: new Date().toISOString() });
  await page.waitForURL(/\/onboarding/, { timeout: 45_000 });

  begin('02_PROFILE_ONBOARDING');
  await page.getByTestId('profile-stage').waitFor({ state: 'visible' });
  await pause(2_000);
  for (let index = 0; index < 3; index += 1) {
    const answer = page.getByTestId('profile-answer');
    await answer.waitFor({ state: 'visible', timeout: 60_000 });
    await human.type(answer, onboardingAnswers[index], { delay: 20 });
    const response = page.waitForResponse((item) => item.url().includes('/api/profile-onboarding/message') && item.request().method() === 'POST', { timeout: 180_000 });
    await human.click(page.getByTestId('profile-send'), { after: 700 });
    const saved = await response;
    if (!saved.ok()) throw new Error(`画像第 ${index + 1} 题保存失败：${saved.status()}`);
    await pause(1_100);
  }
  const continueLater = page.getByRole('button', { name: '稍后继续', exact: true });
  await human.move(continueLater);
  await pause(2_000);
  await human.click(continueLater, { after: 1_000 });
  await page.waitForURL((url) => !url.pathname.includes('/onboarding'), { timeout: 90_000 });
  await page.locator('#input').waitFor({ state: 'visible', timeout: 60_000 });
  if (!rehearsal) await holdUntil(page, human, startedAt, 90);

  async function listItems() {
    const response = await context.request.get(`${baseUrl}/api/items/list`, { headers });
    if (!response.ok()) throw new Error(`读取学习产物失败：${response.status()}`);
    return (await response.json()).data ?? [];
  }

  async function ensureArtifact(type) {
    const items = await listItems();
    const found = items.find((item) => type === 'lecture'
      ? /lecture|document|handout/.test(artifactKind(item))
      : /exam|question|practice/.test(artifactKind(item)));
    if (found) return found;
    const body = type === 'lecture'
      ? { type: 'lecture', title: '校园成绩分析 · 列表推导式讲义', chapter: 'Python 数据分析', content: fallbackLecture, raw_data: { source: 'demo-visible-ai-flow' } }
      : { type: 'question', title: '列表推导式 · 课后练习', chapter: 'Python 数据分析', content: '3 道列表推导式练习，包含答案与解析。', raw_data: { questions: fallbackQuestions, source: 'demo-visible-ai-flow' } };
    const saved = await context.request.post(`${baseUrl}/api/items/save`, { headers, data: body });
    if (!saved.ok()) throw new Error(`学习产物兜底保存失败：${saved.status()} ${await saved.text()}`);
    return (await saved.json()).data;
  }

  async function generateArtifact(prompt, kind) {
    await sendChat(page, human, prompt, 150_000);
    await pause(1_500);
    const items = await listItems();
    const match = items.find((item) => kind === 'lecture'
      ? /lecture|document|handout/.test(artifactKind(item))
      : /exam|question|practice/.test(artifactKind(item)));
    if (match) return match;
    return ensureArtifact(kind);
  }

  begin('03_AI_UPLOAD_AND_GENERATION');
  await pause(3_200);
  const newConversation = page.getByRole('button', { name: /新建对话/ }).first();
  if (await newConversation.isVisible().catch(() => false)) await human.click(newConversation);
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 30_000 });
  await human.click(page.locator('#imageTool'));
  const chooser = await chooserPromise;
  await chooser.setFiles(path.join(projectRoot, 'automation', 'campus-scores-study.md'));
  await page.locator('#materialList').waitFor({ state: 'visible', timeout: 90_000 });
  await page.waitForFunction(() => /campus-scores-study|校园成绩数据分析案例/.test(document.querySelector('#materialList')?.textContent || '') && /已解析|可用|完成/.test(document.querySelector('#materialList')?.textContent || ''), null, { timeout: 120_000 });
  await pause(3_000);

  const lecture = await generateArtifact(mainPrompt, 'lecture');
  await pause(4_000);
  const adventurePrepare = context.request.post(`${baseUrl}/api/adventure/prepare`, {
    headers,
    data: { topic_hint: 'Python 列表推导式与校园成绩数据分析', thread_id: `full-demo-${Date.now()}`, source_ids: [] },
    timeout: 210_000,
  }).then(async (response) => response.ok() ? (await response.json()).data : null).catch(() => null);
  const practice = await generateArtifact(practicePrompt, 'practice');
  await pause(3_000);

  const graphStamp = `${registration.user_id}-${Date.now()}`;
  const graphOrchestration = context.request.post(`${baseUrl}/api/learning-graphs/orchestrate`, {
    headers,
    data: {
      request_id: `full-demo-${graphStamp}`,
      idempotency_key: `full-demo-graph-${graphStamp}`,
      thread_id: `full-demo-${graphStamp}`,
      user_goal: '系统掌握 Python 数据分析，并能独立完成校园成绩数据的清洗、分析与可视化',
      domain: 'Python 数据分析',
      locale: 'zh-CN',
      source_material_ids: [],
      update_mode: 'CREATE',
      graph_revision: 0,
      replaced_source_ref_ids: [],
    },
    timeout: 210_000,
  }).then(async (response) => response.ok() ? (await response.json()).data : null).catch(() => null);

  const artifactsToggle = page.locator('#artifactsToggle');
  await human.click(artifactsToggle);
  await page.locator('#artifactSideList button').first().waitFor({ state: 'visible', timeout: 45_000 });
  await human.click(page.locator('#artifactSideList button').first());
  await page.locator('#artifactDrawer:not([hidden])').waitFor({ state: 'visible', timeout: 45_000 });
  await human.scroll(420, 280);
  await pause(3_000);
  await human.click(page.locator('#closeArtifact'));
  if (!rehearsal) await holdUntil(page, human, startedAt, 220);

  begin('04_RESOURCES_VIDEO_NOTES_SEARCH');
  await openLearningTool(page, human, '资料库');
  await page.getByTestId('real-material-library').waitFor({ state: 'visible', timeout: 60_000 });
  const resourceSearch = page.getByPlaceholder('搜索资料名称、分类或内容');
  if (await resourceSearch.isVisible().catch(() => false)) await human.type(resourceSearch, '校园成绩');
  await pause(4_000);

  await backToAi(page, human);
  await openLearningTool(page, human, '视频学习');
  await page.getByTestId('video-page').waitFor({ state: 'visible', timeout: 45_000 });
  await human.scroll(360, 300);
  await pause(4_000);

  await backToAi(page, human);
  await openLearningTool(page, human, '学习笔记');
  await page.getByTestId('notes-page').waitFor({ state: 'visible', timeout: 45_000 });
  const firstNote = page.getByRole('button', { name: '写第一篇笔记', exact: true });
  const newNote = page.getByRole('button', { name: '新建笔记', exact: true }).first();
  await human.click((await firstNote.isVisible().catch(() => false)) ? firstNote : newNote);
  const titleInput = page.getByPlaceholder('笔记标题');
  const contentInput = page.getByPlaceholder('在这里写下你的理解、感悟和思考…');
  await titleInput.waitFor({ state: 'visible' });
  const savedResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && /\/api\/notes\/\d+$/.test(new URL(response.url()).pathname) && response.ok(), { timeout: 60_000 });
  await human.type(titleInput, noteTitle, { delay: 30 });
  await human.type(contentInput, noteContent, { delay: 18 });
  await savedResponse;
  await pause(2_000);
  await human.click(page.getByTestId('notes-ai-drawer-open').first());
  await page.getByTestId('notes-ai-drawer').waitFor({ state: 'visible' });
  await pause(3_000);
  const closeDrawer = page.getByLabel('Close');
  if (await closeDrawer.isVisible().catch(() => false)) await human.click(closeDrawer);
  else await page.keyboard.press('Escape');

  await human.click(page.getByTestId('global-search-button'));
  const globalSearch = page.getByPlaceholder('搜索资料、笔记、题目…');
  await human.type(globalSearch, '列表推导式');
  await globalSearch.press('Enter');
  const searchResult = page.getByText(noteTitle, { exact: false }).first();
  await searchResult.waitFor({ state: 'visible', timeout: 45_000 });
  await human.move(searchResult);
  await pause(3_000);
  if (!rehearsal) await holdUntil(page, human, startedAt, 300);

  begin('05_LEARNING_EXAM_PROFILE');
  await graphOrchestration;
  await backToAi(page, human);
  await openLearningTool(page, human, '我的学习');
  await page.getByTestId('mylearning-overview').waitFor({ state: 'visible', timeout: 90_000 });
  const enterLearning = page.getByRole('button', { name: /进入学习/ }).first();
  if (await enterLearning.isVisible().catch(() => false)) {
    await human.click(enterLearning);
    await page.getByTestId('mylearning-detail').waitFor({ state: 'visible', timeout: 60_000 });
    const graphToggle = page.getByTestId('learning-graph-toggle');
    if (await graphToggle.isVisible().catch(() => false)) await human.click(graphToggle);
    await human.scroll(420, 280);
  }
  await pause(4_000);

  await backToAi(page, human);
  await openLearningTool(page, human, '练习与测评');
  await page.getByTestId('module-page-exam').waitFor({ state: 'visible', timeout: 60_000 });
  const practiceCard = page.locator(`[data-artifact-id="${practice?.id ?? ''}"]`).first();
  const anyPractice = page.locator('[data-testid="artifact-output-list"] [data-artifact-id]').first();
  const card = (await practiceCard.isVisible().catch(() => false)) ? practiceCard : anyPractice;
  if (await card.isVisible().catch(() => false)) {
    await human.click(card);
    await page.locator('.ant-modal-content').waitFor({ state: 'visible' });
    await pause(4_000);
    const modalClose = page.locator('.ant-modal-close');
    if (await modalClose.isVisible().catch(() => false)) await human.click(modalClose);
  }
  await human.scroll(520, 320);
  await pause(3_000);

  await human.click(page.getByTestId('global-user-menu-button'));
  await human.click(page.getByRole('button', { name: '个人中心', exact: true }).last());
  await page.getByTestId('personal-center-first-screen').waitFor({ state: 'visible', timeout: 60_000 });
  await pause(3_000);
  await human.scroll(760, 320);
  await page.getByTestId('profile-ten-dimensions').waitFor({ state: 'visible', timeout: 45_000 });
  await pause(5_000);
  if (!rehearsal) await holdUntil(page, human, startedAt, 360);

  begin('06_RELAX_AND_ADVENTURE');
  await human.click(page.getByTestId('relax-moment-trigger'));
  const relax = page.getByTestId('relax-moment-overlay');
  await relax.waitFor({ state: 'visible' });
  await page.locator('canvas[aria-label*="烟花"]').click({ position: { x: 900, y: 260 } });
  await pause(5_000);
  await page.locator('canvas[aria-label*="烟花"]').click({ position: { x: 520, y: 350 } });
  await pause(4_000);
  await human.click(page.getByRole('button', { name: '结束轻松一下', exact: true }));
  await relax.waitFor({ state: 'hidden', timeout: 30_000 });
  await backToAi(page, human);

  const prepared = await adventurePrepare;
  if (prepared) {
    await openLearningTool(page, human, '拾光漫游');
    await page.locator('#adventurePrepare:not([hidden])').waitFor({ state: 'visible', timeout: 90_000 });
    await pause(4_000);
    await human.click(page.locator('#adventurePrepareStart'));
  } else {
    const fallback = await context.request.post(`${baseUrl}/api/adventure/start`, {
      headers,
      data: { topic: 'Python 列表推导式与校园成绩数据分析', magic_school: 'wood', source_ids: [], source_type: 'manual', force_new: true, prepared_plan_id: null },
      timeout: 90_000,
    });
    if (!fallback.ok()) throw new Error(`拾光漫游启动失败：${fallback.status()}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#adventureEntry').waitFor({ state: 'visible', timeout: 45_000 });
    await human.click(page.locator('#adventureEntry'));
  }
  await page.locator('.shiguang-overlay').waitFor({ state: 'visible', timeout: 90_000 });
  await pause(5_000);
  const dialogueNext = page.locator('[data-action="dialogue-next"]').first();
  if (await dialogueNext.isVisible().catch(() => false)) await human.click(dialogueNext);
  if (!rehearsal) await holdUntil(page, human, startedAt, 416);

  void lecture;
  return finishMarkers();
}

await recordFlow({ kind: 'full', rehearsal, targetSeconds, accepted, flow: runFullFlow });
