import {
  backToAi,
  baseUrl,
  createHumanDriver,
  holdUntil,
  pause,
  readSession,
  recordFlow,
} from './demo-utils.mjs';

const rehearsal = process.argv.includes('--rehearsal');
const targetSeconds = 60;
const accepted = { min: 55, max: 65 };

async function runHighlightFlow({ page, context, startedAt }) {
  const session = await readSession();
  const login = await context.request.post(`${baseUrl}/api/auth/login`, {
    data: { username: session.username, password: session.password },
  });
  if (!login.ok()) throw new Error(`亮点版演示账号登录失败：${login.status()}`);
  const auth = (await login.json()).data;
  await context.addInitScript(({ token, userId, username }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('auth_token', token);
    localStorage.setItem('ml_auth_token', token);
    localStorage.setItem('ml_current_user_id', String(userId));
    localStorage.setItem('kaki_user', JSON.stringify({ userId, username, hasProfile: true }));
  }, { token: auth.token, userId: auth.user_id, username: auth.username });

  const human = createHumanDriver(page);
  const markers = [];
  let current = null;
  const begin = (name) => {
    if (current) current.end = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    current = { name, start: Number(((Date.now() - startedAt) / 1000).toFixed(2)) };
    markers.push(current);
  };

  begin('01_AI_PERSONALIZED_WORKSPACE');
  await page.goto(`${baseUrl}/ai-learning`, { waitUntil: 'domcontentloaded' });
  await page.locator('#input').waitFor({ state: 'visible', timeout: 60_000 });
  const relevantThread = page.locator('.conversation-item, .history-item, button').filter({ hasText: /校园成绩|列表推导式/ }).last();
  if (await relevantThread.isVisible().catch(() => false)) await human.click(relevantThread, { after: 700 });
  await page.locator('#messages').waitFor({ state: 'visible' });
  await human.scroll(420, 280);
  await holdUntil(page, human, startedAt, 10);

  begin('02_REAL_AI_ARTIFACT');
  await human.click(page.locator('#artifactsToggle'));
  const artifact = page.locator('#artifactSideList button').first();
  await artifact.waitFor({ state: 'visible', timeout: 45_000 });
  await human.click(artifact);
  await page.locator('#artifactDrawer:not([hidden])').waitFor({ state: 'visible', timeout: 45_000 });
  await human.scroll(320, 220);
  await holdUntil(page, human, startedAt, 22);

  begin('03_LEARNING_GRAPH');
  await human.click(page.locator('#closeArtifact'));
  await backToAi(page, human);
  await page.getByTestId('learning-tool-composer-trigger').click();
  const tray = page.getByTestId('learning-tool-tray');
  await tray.waitFor({ state: 'visible' });
  await human.click(tray.getByRole('button', { name: '我的学习', exact: true }));
  await page.getByTestId('mylearning-overview').waitFor({ state: 'visible', timeout: 60_000 });
  const enter = page.getByRole('button', { name: /进入学习/ }).first();
  if (await enter.isVisible().catch(() => false)) {
    await human.click(enter, { after: 600 });
    await page.getByTestId('mylearning-detail').waitFor({ state: 'visible', timeout: 45_000 });
    const graph = page.getByTestId('learning-graph-toggle');
    if (await graph.isVisible().catch(() => false)) await human.click(graph, { after: 500 });
    await human.scroll(360, 260);
  }
  await holdUntil(page, human, startedAt, 34);

  begin('04_EVIDENCE_PROFILE');
  await human.click(page.getByTestId('global-user-menu-button'));
  await human.click(page.getByRole('button', { name: '个人中心', exact: true }).last(), { after: 500 });
  await page.getByTestId('personal-center-first-screen').waitFor({ state: 'visible', timeout: 45_000 });
  await human.scroll(680, 300);
  await page.getByTestId('profile-ten-dimensions').waitFor({ state: 'visible', timeout: 45_000 });
  await holdUntil(page, human, startedAt, 46);

  begin('05_HARVEST_ADVENTURE');
  await backToAi(page, human);
  await page.locator('#adventureEntry').waitFor({ state: 'visible', timeout: 45_000 });
  await human.click(page.locator('#adventureEntry'), { after: 700 });
  const overlay = page.locator('.shiguang-overlay');
  if (!await overlay.isVisible().catch(() => false)) {
    const prepare = page.locator('#adventurePrepare:not([hidden])');
    if (await prepare.isVisible().catch(() => false)) await human.click(page.locator('#adventurePrepareStart'));
  }
  await overlay.waitFor({ state: 'visible', timeout: 60_000 });
  const next = page.locator('[data-action="dialogue-next"]').first();
  if (await next.isVisible().catch(() => false)) await human.click(next, { after: 450 });
  await holdUntil(page, human, startedAt, 60);

  if (current) current.end = Number(((Date.now() - startedAt) / 1000).toFixed(2));
  await pause(120);
  return markers;
}

await recordFlow({ kind: 'highlight', rehearsal, targetSeconds, accepted, flow: runHighlightFlow });
