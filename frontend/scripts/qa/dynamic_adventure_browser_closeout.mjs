import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:8765';
const output = process.env.KAKI_EVIDENCE || path.resolve('evidence/dynamic-adventure-10-browser-closeout-20260801');
const formalUrl = `${base}/ai-learning`;
await mkdir(output, { recursive: true });
const recordVideo = process.env.KAKI_RECORD_VIDEO === '1';
const recordingStartedAt = Date.now();
const videoMarkers = [];

const stamp = Date.now();
const username = `dynamic10_${stamp}`;
const password = 'Dynamic10!2026';
const email = `${username}@example.test`;
const checks = [];
const consoleErrors = [];
const pageErrors = [];
const networkErrors = [];
const adventureRequests = [];
const dialogueByState = {};
const screenshots = [];
let motionEvidence = [];

function check(name, condition, details = null) {
  checks.push({ name, pass: Boolean(condition), details });
  if (!condition) throw new Error(`${name}: ${JSON.stringify(details)}`);
}

function publicSnapshot(snapshot) {
  return {
    run_id: snapshot?.run_id,
    state: snapshot?.state,
    boss_stage: snapshot?.archive?.boss_stage,
    remedial_required: snapshot?.archive?.remedial_required,
    branch_choice: snapshot?.archive?.branch_choice,
    narrative: snapshot?.narrative || null,
  };
}

function acceptedAnswer(task, fallback) {
  const groups = Array.isArray(task?.accepted_groups) ? task.accepted_groups : [];
  const terms = groups.flatMap((group) => Array.isArray(group) ? group : [group]).filter(Boolean);
  return terms.length ? `我的判断依据包括：${terms.join('、')}。我会先核对适用条件，再用例子验证。` : fallback;
}

function semanticAnswer(task, fallback) {
  const question = task?.question || '';
  if (/[εδ]|epsilon|delta/i.test(question)) {
    return 'δ 要根据给定的 ε 选择，使得当 0 < |x-a| < δ 时，能够保证 |f(x)-L| < ε；ε 越小，通常需要相应缩小 δ。';
  }
  if (/光反应|暗反应/.test(question)) {
    return `光反应产生 ATP 和 NADPH，暗反应虽然不直接使用光，却依赖这些产物，所以两者相互耦合。${acceptedAnswer(task, '')}`;
  }
  if (/梯度/.test(question)) {
    return '梯度指向函数增长最快的方向，梯度下降要沿其反方向，也就是负梯度方向。';
  }
  if (/生成器|列表推导/.test(question)) {
    return '列表推导式会立即生成完整列表；生成器采用惰性求值，在迭代时按需生成元素，因此更节省内存。';
  }
  return acceptedAnswer(task, fallback);
}

async function submitTask(page, task, textAnswer) {
  if (task?.type === 'multiple_choice') {
    const question = task.question || '';
    const options = task.options || [];
    const preferred = [
      /ATP.*NADPH|NADPH.*ATP/,
      ...(/暗反应被称为/.test(question) ? [/不直接需要光/] : []),
      ...(/蓝图生成.*完整计划/.test(question) ? [/输入|核心要素|结构/] : []),
      ...(/(阴天|光照减弱|光强)/.test(question) ? [/光反应.*速率|光照强度/] : []),
      ...(/(耦合|联系|依赖)/.test(question) ? [/暗反应.*依赖.*(?:ATP|NADPH|光反应)|光反应.*(?:ATP|NADPH).*暗反应/] : []),
      ...(/(梯度下降方向)/.test(question) ? [/负梯度|反方向/] : []),
    ];
    let index = -1;
    for (const pattern of preferred) {
      index = options.findIndex((option) => pattern.test(option));
      if (index >= 0) break;
    }
    if (index < 0) index = Math.max(0, Number(task.correct_option || 0));
    await page.locator('[data-action="answer"]').nth(index).click();
    return;
  }
  await page.locator('.shiguang-answer textarea').fill(textAnswer);
  await page.locator('.shiguang-answer').evaluate((form) => form.requestSubmit());
}

function evidenceNgrams(value) {
  const clean = String(value || '').toLowerCase().replace(/[^\p{L}\p{N}+]+/gu, '');
  const grams = new Set();
  for (let index = 0; index < clean.length - 1; index += 1) grams.add(clean.slice(index, index + 2));
  for (const token of String(value || '').toLowerCase().match(/[a-z][a-z0-9+_-]*/g) || []) grams.add(token);
  return grams;
}

function rankedChoiceIndices(task, evidence = '') {
  const options = Array.isArray(task?.options) ? task.options : [];
  const hintGrams = evidenceNgrams(task?.hint || '');
  const evidenceGrams = evidenceNgrams(evidence);
  return options.map((option, index) => {
    const lower = String(option || '').toLowerCase();
    let score = 0;
    for (const gram of hintGrams) if (lower.includes(gram)) score += 5;
    for (const gram of evidenceGrams) if (lower.includes(gram)) score += 2;
    if (/atp.*nadph|nadph.*atp/i.test(lower)) score += 20;
    if (/nad\+.*fad.*再生|再生.*nad\+|电子传递链.*辅酶/i.test(lower)) score += 20;
    if (/不需要|完全|总是|一定|只有.*才/.test(lower)) score -= 2;
    return { index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index).map((item) => item.index);
}

async function submitVisibleAnswer(page, task, evidence = '', rank = 0) {
  await page.locator('[data-action="answer"], .shiguang-answer textarea').first().waitFor({ state: 'attached' });
  const visibleChoices = page.locator('[data-action="answer"]');
  if (await visibleChoices.count()) {
    const visibleOptions = await visibleChoices.allTextContents();
    const ranking = rankedChoiceIndices({ ...task, type: 'multiple_choice', options: visibleOptions }, evidence);
    const choice = visibleChoices.nth(ranking[Math.min(rank, ranking.length - 1)] || 0);
    await choice.scrollIntoViewIfNeeded();
    await choice.click();
    return;
  }
  const prompt = `${task?.question || ''} ${task?.hint || ''} ${evidence}`;
  const reasoning = /(突然|停止).*(光照|光)|立即停止|短暂继续|耗尽/i.test(prompt)
    ? '暗反应不直接需光，但依赖光反应产物。停止光照后光反应停止，ATP 和 NADPH 会断供；已有 ATP 和 NADPH 可让暗反应短暂继续，但产物耗尽后暗反应就会停止。'
    : /糖酵解.*柠檬酸循环|柠檬酸循环.*糖酵解/i.test(prompt)
    ? '糖酵解产生丙酮酸；丙酮酸随后氧化脱羧生成乙酰辅酶A，乙酰辅酶A进入柠檬酸循环。因此循环不直接进行糖酵解，却依赖糖酵解提供的碳源产物。'
    : /另一个代谢过程|依赖其产物|举出.*例子|某种物质但依赖/i.test(prompt)
    ? '例如柠檬酸循环本身不直接消耗氧气，却依赖有氧电子传递链利用氧气氧化NADH和FADH2、再生NAD+与FAD；缺氧时氧化型辅酶耗尽，柠檬酸循环就会停滞。'
    : /柠檬酸|Krebs|NAD\+|FAD|电子传递链|有氧呼吸/i.test(prompt)
    ? '缺氧会使电子传递链停止，NADH和FADH2无法被氧化，NAD+与FAD不能再生；柠檬酸循环因缺少氧化型辅酶而停滞。'
    : /光反应|暗反应|ATP|NADPH|卡尔文/i.test(prompt)
      ? '暗反应不直接需光，但依赖光反应产物。停止光照后光反应停止，ATP 和 NADPH 会断供；已有 ATP 和 NADPH 可让暗反应短暂继续，但产物耗尽后暗反应就会停止，卡尔文循环不能持续固定二氧化碳。'
      : '我先说明适用条件和因果机制，再用一个新情境检验这条规则，而不是只重复结论。';
  const answer = `${reasoning} ${evidence} ${task?.hint || ''}`.trim().slice(0, 480);
  await page.locator('.shiguang-answer textarea').fill(answer);
  await page.locator('.shiguang-answer').evaluate((form) => form.requestSubmit());
}

async function requestVisibleHint(page) {
  const hint = page.locator('[data-action="hint"]:visible');
  if (!(await hint.count())) return false;
  await hint.first().click();
  await page.waitForFunction(() => !document.querySelector('.shiguang-overlay')?.classList.contains('is-busy'));
  await chooseDestination({ stateLabel: 'HINT' });
  return true;
}

async function installMotionObserver(page, seed = []) {
  await page.evaluate((initial) => {
    window.__ultimate08MotionEvidence = Array.isArray(initial) ? initial : [];
    const record = () => {
      const enemy = document.querySelector('[data-enemy-root]');
      const spell = document.querySelector('[data-spell-phase]');
      const scene = document.querySelector('.shiguang-scene');
      const item = {
        at: Math.round(performance.now()),
        enemy: enemy?.getAttribute('data-enemy-state') || '',
        spell: spell?.getAttribute('data-spell-phase') || '',
        scene: scene?.getAttribute('data-scene-state') || '',
        celebration: Boolean(document.querySelector('.shiguang-celebration-bursts')),
      };
      const last = window.__ultimate08MotionEvidence.at(-1);
      if (!last || JSON.stringify(last).replace(/"at":\d+,?/, '') !== JSON.stringify(item).replace(/"at":\d+,?/, '')) {
        window.__ultimate08MotionEvidence.push(item);
      }
    };
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true });
    record();
  }, seed);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: recordVideo ? { width: 1920, height: 1080 } : { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
  ...(recordVideo ? { recordVideo: { dir: output, size: { width: 1920, height: 1080 } } } : {}),
});

const register = await context.request.post(`${base}/api/auth/register`, {
  data: { username, password, email },
});
check('real registration succeeds', register.ok(), { status: register.status() });
const registered = (await register.json()).data;
const headers = { Authorization: `Bearer ${registered.token}` };
const onboardingStart = await context.request.post(`${base}/api/profile-onboarding/start`, { headers });
check('real onboarding starts', onboardingStart.ok(), { status: onboardingStart.status() });
const onboardingTask = (await onboardingStart.json()).data.task_id;
const onboardingSkip = await context.request.post(`${base}/api/profile-onboarding/skip`, {
  headers,
  data: { task_id: onboardingTask },
});
check('real onboarding skip completes profile', onboardingSkip.ok(), { status: onboardingSkip.status() });

await context.addInitScript(({ token, storedUser }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(storedUser));
  localStorage.setItem('ml_current_user_id', String(storedUser.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, {
  token: registered.token,
  storedUser: { userId: registered.user_id, username, email, avatarUrl: null, hasProfile: true },
});

const page = await context.newPage();
const recordedPageVideo = page.video();
page.setDefaultTimeout(45_000);
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => {
  const error = request.failure()?.errorText || '';
  const expectedIframeReplacement = request.url().endsWith('/ai-workspace/ai-workspace-test.html') && error === 'net::ERR_ABORTED';
  if (!expectedIframeReplacement) networkErrors.push({ kind: 'requestfailed', url: request.url(), error });
});
page.on('response', async (response) => {
  const url = response.url();
  if (response.status() >= 400) networkErrors.push({ kind: 'http', status: response.status(), url });
  if (/\/api\/adventure\/(prepare|start|current|advance)/.test(url)) {
    adventureRequests.push({ method: response.request().method(), path: new URL(url).pathname, status: response.status() });
  }
});

async function shot(name) {
  await page.waitForTimeout(250);
  const target = path.join(output, name);
  await page.screenshot({ path: target, fullPage: true });
  screenshots.push(target);
  videoMarkers.push({ name, seconds: Number(((Date.now() - recordingStartedAt) / 1000).toFixed(2)) });
}

async function waitState(expected) {
  await page.waitForFunction((value) => document.querySelector('.shiguang-overlay')?.dataset.state === value, expected, { timeout: 60_000 });
}

async function drainDialogue(stateLabel) {
  const lines = [];
  for (let turn = 0; turn < 48; turn += 1) {
    const dialogue = page.locator('.shiguang-dialogue');
    if (!await dialogue.count()) break;
    const before = await dialogue.evaluate((node) => ({
      index: Number(node.dataset.queueIndex || 0),
      complete: node.dataset.lineComplete === 'true',
    }));
    if (!before.complete) {
      await dialogue.locator('[data-action="dialogue-next"]').click();
      await page.waitForFunction(({ index }) => {
        const node = document.querySelector('.shiguang-dialogue');
        return !node || (Number(node.dataset.queueIndex || 0) === index && node.dataset.lineComplete === 'true');
      }, before, { timeout: 30_000 });
    }
    if (await dialogue.count()) {
      lines.push(await dialogue.evaluate((node) => ({
        index: Number(node.dataset.queueIndex || 0),
        speaker: node.querySelector('.shiguang-dialogue-speaker small')?.textContent?.trim() || '',
        text: node.querySelector('[data-dialogue-text]')?.textContent?.trim() || '',
      })));
      await dialogue.locator('[data-action="dialogue-next"]').click();
      await page.waitForFunction(({ index }) => {
        const node = document.querySelector('.shiguang-dialogue');
        return !node || Number(node.dataset.queueIndex || 0) > index;
      }, before, { timeout: 30_000 });
    }
  }
  if (stateLabel) dialogueByState[stateLabel] = [...(dialogueByState[stateLabel] || []), ...lines];
  return lines;
}

async function settle(stateLabel) {
  await page.waitForFunction(() => {
    const current = document.querySelector('.shiguang-overlay');
    const phase = current?.dataset.directionPhase || '';
    return current && !current.classList.contains('is-busy') && (phase === 'dialogue' || phase === 'interactive');
  }, null, { timeout: 60_000 });
  if (await page.locator('.shiguang-dialogue').count()) await drainDialogue(stateLabel);
  await page.waitForFunction(() => {
    const current = document.querySelector('.shiguang-overlay');
    return current && !current.classList.contains('is-busy')
      && current.dataset.directionPhase === 'interactive'
      && !document.querySelector('.shiguang-dialogue');
  }, null, { timeout: 60_000 });
}

async function chooseDestination({ preferredId = '', stateLabel = '' } = {}) {
  await settle(stateLabel);
  if (!await page.locator('.shiguang-destination-choice').count()) return;
  let destination = preferredId
    ? page.locator(`[data-action="destination"][data-destination-id="${preferredId}"]`)
    : page.locator('[data-action="destination"][data-destination-kind="stay"]');
  if (!await destination.count()) destination = page.locator('[data-action="destination"][data-destination-kind="travel"]').first();
  await destination.click();
  await settle(stateLabel);
}

async function action(name) {
  await page.locator(`[data-action="${name}"]`).evaluate((button) => button.click());
}

async function currentSnapshot() {
  const response = await context.request.get(`${base}/api/adventure/current`, { headers });
  check('current adventure endpoint succeeds', response.ok(), { status: response.status() });
  return (await response.json()).data;
}

try {
  const navigation = await page.goto(formalUrl, { waitUntil: 'domcontentloaded' });
  check('formal standalone workspace returns 200', navigation?.status() === 200, { status: navigation?.status() });
  await page.getByTestId('learning-tool-composer-trigger').waitFor({ state: 'visible' });

  const assistantCount = await page.locator('#messages .msg.assistant').count();
  await page.locator('#input').fill('我总把光合作用的光反应和暗反应混在一起：暗反应不直接用光，为什么还依赖光反应？');
  await page.locator('#send').click();
  await page.waitForFunction((count) => document.querySelectorAll('#messages .msg.assistant').length > count
    && !document.querySelector('#send')?.disabled, assistantCount, { timeout: 120_000 });
  check('current real question is sent through visible chat controls', true);

  const prepareResponsePromise = page.waitForResponse((response) => response.url().includes('/api/adventure/prepare') && response.request().method() === 'POST', { timeout: 240_000 });
  await page.getByTestId('learning-tool-composer-trigger').click();
  await page.getByTestId('learning-tool-tray').waitFor({ state: 'visible' });
  await page.getByTestId('learning-tool-tray').getByRole('button', { name: '拾光漫游', exact: true }).click();
  const prepareResponse = await prepareResponsePromise;
  check('real prepare succeeds', prepareResponse.ok(), { status: prepareResponse.status() });
  const prepared = (await prepareResponse.json()).data;
  check('prepare returns frozen public narrative', Boolean(prepared.narrative), publicSnapshot(prepared));
  await page.locator('#adventurePrepare:not([hidden])').waitFor({ state: 'visible' });
  await shot('01-prepare.png');

  const startResponsePromise = page.waitForResponse((response) => response.url().includes('/api/adventure/start') && response.request().method() === 'POST', { timeout: 90_000 });
  await page.locator('#adventurePrepareStart').click();
  const startResponse = await startResponsePromise;
  check('real prepared start succeeds', startResponse.ok(), { status: startResponse.status() });
  const started = (await startResponse.json()).data;
  await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
  await installMotionObserver(page);
  await waitState('goal');
  check('start keeps the same frozen narrative', JSON.stringify(started.narrative) === JSON.stringify(prepared.narrative));

  const recommendations = started.narrative.recommended_destinations || [];
  await settle('GOAL');
  const visibleDestinations = await page.locator('[data-action="destination"][data-destination-kind="travel"]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.dataset.destinationId,
    label: node.textContent.trim(),
    registered: Boolean(window.KakiAdventureSceneRegistry?.has(node.dataset.destinationId)),
  })));
  check('camp destinations come from narrative recommendations',
    JSON.stringify(visibleDestinations.map((item) => item.id)) === JSON.stringify(recommendations.map((item) => item.scene_id)),
    { visibleDestinations, recommendations });
  check('every narrative destination exists in Scene Registry', visibleDestinations.every((item) => item.registered), visibleDestinations);
  await shot('02-dynamic-destinations.png');
  const selectedDestination = recommendations[0].scene_id;
  await chooseDestination({ preferredId: selectedDestination, stateLabel: 'GOAL' });
  check('opening state_copy is visibly spoken', (dialogueByState.GOAL || []).some((line) => line.text === started.narrative.state_copy.opening), {
    expected: started.narrative.state_copy.opening,
    actual: dialogueByState.GOAL,
  });

  await action('continue');
  await waitState('scroll');
  await chooseDestination({ stateLabel: 'SCROLL' });
  check('SCROLL uses rule_reveal state_copy', (dialogueByState.SCROLL || []).some((line) => line.text === started.narrative.state_copy.rule_reveal), dialogueByState.SCROLL);

  await action('continue');
  await waitState('method');
  await chooseDestination({ stateLabel: 'METHOD' });
  const routeFrames = await page.locator('[data-action="method"] span').allTextContents();
  check('METHOD visibly consumes both dynamic route action frames',
    routeFrames.includes(started.narrative.routes.understanding.action_frame)
      && routeFrames.includes(started.narrative.routes.practice.action_frame),
    { routeFrames, routes: started.narrative.routes });
  await shot('03-dynamic-route-frames.png');

  await page.locator('[data-action="method"][data-method="practice"]').click();
  await waitState('trial');
  await chooseDestination({ stateLabel: 'TRIAL' });
  check('TRIAL uses first_trial state_copy', (dialogueByState.TRIAL || []).some((line) => line.text === started.narrative.state_copy.first_trial), dialogueByState.TRIAL);
  await shot('04-trial.png');

  const trialTask = started.content.practice.trial;
  if (trialTask.type === 'multiple_choice') {
    const ranking = rankedChoiceIndices(trialTask, started.content.scroll.rule);
    const wrongIndex = ranking.length > 1 ? ranking[ranking.length - 1] : 0;
    await page.locator('[data-action="answer"]').nth(wrongIndex).click();
  } else {
    await page.locator('.shiguang-answer textarea').fill('我还没有找到判断条件。');
    await page.locator('.shiguang-answer').evaluate((form) => form.requestSubmit());
  }
  await waitState('supply');
  const wrongSupply = await currentSnapshot();
  check('intentional wrong TRIAL reaches targeted remediation', wrongSupply.archive.remedial_required === true, publicSnapshot(wrongSupply));
  await chooseDestination({ stateLabel: 'SUPPLY-WRONG' });
  await shot('05-supply-remediation.png');
  const remedyTask = started.content.remedy;
  await requestVisibleHint(page);
  let remedySolved = false;
  const remedyAttempts = remedyTask.type === 'multiple_choice' ? remedyTask.options.length : 3;
  for (let rank = 0; rank < remedyAttempts && !remedySolved; rank += 1) {
    await submitVisibleAnswer(page, remedyTask, `${started.content.scroll.rule} ${remedyTask.hint || ''}`, rank);
    await settle(`REMEDY-ATTEMPT-${rank + 1}`);
    remedySolved = (await currentSnapshot()).state === 'INTERLEAVE';
    if (!remedySolved) await requestVisibleHint(page);
  }
  check('visible remediation is solved without a state jump', remedySolved);
  const recovered = await currentSnapshot();
  check('visible hint and remedy recover the same run', recovered.archive.remedial_required === false, publicSnapshot(recovered));
  await shot('05b-remedy-recovered.png');

  if (false) {
  await submitTask(page, trialTask, semanticAnswer(trialTask, `我会解释 ${started.archive.topic} 的适用条件，并给出可以检验的例子。`));
  await waitState('supply');
  const correctSupply = await currentSnapshot();
  check('correct TRIAL reaches ordinary SUPPLY', correctSupply.archive.remedial_required === false, publicSnapshot(correctSupply));
  await chooseDestination({ stateLabel: 'SUPPLY' });
  check('ordinary SUPPLY uses supply_success state_copy', (dialogueByState.SUPPLY || []).some((line) => line.text === started.narrative.state_copy.supply_success), dialogueByState.SUPPLY);
  await shot('05-supply-correct.png');

  await action('continue');
  }
  await waitState('interleave');
  await chooseDestination({ stateLabel: 'INTERLEAVE' });
  const interleaveDialogue = Object.entries(dialogueByState)
    .filter(([label]) => label.startsWith('REMEDY') || label.startsWith('INTERLEAVE'))
    .flatMap(([, lines]) => lines || []);
  check('INTERLEAVE uses interleave state_copy', interleaveDialogue.some((line) => line.text === started.narrative.state_copy.interleave), interleaveDialogue);
  const interleaveTask = started.content.practice.interleave;
  let interleaveSolved = false;
  const interleaveAttempts = interleaveTask.type === 'multiple_choice' ? interleaveTask.options.length : 3;
  for (let rank = 0; rank < interleaveAttempts && !interleaveSolved; rank += 1) {
    await submitVisibleAnswer(page, interleaveTask, `${started.content.scroll.rule} ${interleaveTask.hint || ''}`, rank);
    await settle(`INTERLEAVE-ATTEMPT-${rank + 1}`);
    const attemptSnapshot = await currentSnapshot();
    interleaveSolved = attemptSnapshot.state === 'INTERLEAVE' && attemptSnapshot.archive?.boss_ready === true;
    if (!interleaveSolved) {
      await requestVisibleHint(page);
    }
  }
  check('interleave is solved through visible answers and waits for the player decision', interleaveSolved);

  if (false) {
  const interleaveQuestion = interleaveTask.question || '';
  const interleaveAnswer = /生成器/.test(interleaveQuestion)
    ? '列表推导式会立即生成完整列表并占用相应内存；生成器表达式采用惰性求值，在迭代时按需生成元素。'
    : /勾股|三角形/.test(interleaveQuestion)
      ? '勾股定理只适用于直角三角形；必须先确认直角条件，再比较两直角边平方和与斜边平方。'
      : /列表推导式|字符串|元音/.test(interleaveQuestion)
        ? "vowels = [ch for ch in 'hello' if ch in 'aeiou']，用 for 遍历字符串并用 if 条件过滤元音"
        : semanticAnswer(interleaveTask, '我会设计一道题，并用一个例子实现、比较和解释结果');
  await submitTask(page, interleaveTask, interleaveAnswer);
  }
  await settle('INTERLEAVE-RESULT');
  await shot('06-boss-player-decision.png');
  await action('continue');
  await waitState('boss');
  await chooseDestination({ stateLabel: 'BOSS-0' });
  const bossRevealDialogue = Object.entries(dialogueByState)
    .filter(([label]) => label.startsWith('INTERLEAVE') || label.startsWith('BOSS-0'))
    .flatMap(([, lines]) => lines || []);
  check('BOSS reveal uses boss_reveal state_copy', bossRevealDialogue.some((line) => line.text === started.narrative.state_copy.boss_reveal), bossRevealDialogue);
  await shot('07-boss-understand.png');

  const bossExplainTask = started.content.boss[0];
  let bossStageZeroSolved = false;
  const bossStageZeroAttempts = bossExplainTask.type === 'multiple_choice' ? bossExplainTask.options.length : 2;
  for (let rank = 0; rank < bossStageZeroAttempts && !bossStageZeroSolved; rank += 1) {
    await submitVisibleAnswer(page, bossExplainTask, `${started.content.scroll.rule} ${bossExplainTask.hint || ''}`, rank);
    await settle(`BOSS-0-ATTEMPT-${rank + 1}`);
    bossStageZeroSolved = (await currentSnapshot()).archive.boss_stage >= 1;
    if (!bossStageZeroSolved) {
      await requestVisibleHint(page);
    }
  }
  check('BOSS explanation stage is completed through visible answer', bossStageZeroSolved);

  if (false) {
  const bossExplainQuestion = bossExplainTask.question || '';
  const bossExplainAnswer = /生成器/.test(bossExplainQuestion)
    ? '列表推导式立即构造完整列表；生成器表达式是惰性求值，只在迭代时按需产生元素，因此内存使用和执行时机不同。'
    : /列表推导式|iterable|expression/.test(bossExplainQuestion)
      ? '列表推导式先用 for 遍历 iterable，再用 if condition 过滤，最后对 item 执行 expression 并生成新列表。'
    : semanticAnswer(bossExplainTask, `${started.archive.topic}：先解释核心含义、适用条件和执行步骤，再给出例子验证。`);
  await submitTask(page, bossExplainTask, bossExplainAnswer);
  }
  await chooseDestination({ stateLabel: 'BOSS-1' });
  let bossSnapshot = await currentSnapshot();
  check('BOSS understanding stage completes', bossSnapshot.archive.boss_stage === 1, publicSnapshot(bossSnapshot));
  await shot('07-boss-distinguish.png');

  const bossChoiceTask = started.content.boss[1];
  let bossStageOneSolved = false;
  const bossStageOneAttempts = bossChoiceTask.type === 'multiple_choice' ? bossChoiceTask.options.length : 2;
  for (let rank = 0; rank < bossStageOneAttempts && !bossStageOneSolved; rank += 1) {
    await submitVisibleAnswer(page, bossChoiceTask, `${started.content.scroll.rule} ${bossChoiceTask.hint || ''}`, rank);
    await settle(`BOSS-1-ATTEMPT-${rank + 1}`);
    bossStageOneSolved = (await currentSnapshot()).archive.boss_stage >= 2;
    if (!bossStageOneSolved) {
      await requestVisibleHint(page);
    }
  }
  check('BOSS recall and distinction stage is completed through visible answer', bossStageOneSolved);

  if (false) {
  const bossChoiceOptions = started.content.boss[1].options || [];
  let bossChoiceIndex = Number.isInteger(started.content.boss[1].correct_option)
    ? started.content.boss[1].correct_option
    : bossChoiceOptions.findIndex((option) => /(打印|副作用|复杂逻辑|同时)/.test(option));
  if (bossChoiceIndex < 0) bossChoiceIndex = Math.max(0, bossChoiceOptions.findIndex((option) => !/(总是|一定|不能|只要|完全|所有)/.test(option)));
  await page.locator('[data-action="answer"]').nth(bossChoiceIndex).click();
  }
  await chooseDestination({ stateLabel: 'BOSS-2' });
  bossSnapshot = await currentSnapshot();
  check('BOSS distinction stage completes', bossSnapshot.archive.boss_stage === 2, publicSnapshot(bossSnapshot));
  await shot('08-boss-transfer.png');

  const routeBeforeRefresh = await page.evaluate((runId) => ({
    raw: localStorage.getItem(`shiguang_manyou_route_${runId}`),
    scene: document.querySelector('.shiguang-overlay')?.dataset.sceneId || '',
    state: document.querySelector('.shiguang-overlay')?.dataset.state || '',
  }), started.run_id);
  const beforeRefresh = await currentSnapshot();
  const motionBeforeRefresh = await page.evaluate(() => window.__ultimate08MotionEvidence || []);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('learning-tool-composer-trigger').waitFor({ state: 'visible' });
  await page.getByTestId('learning-tool-composer-trigger').click();
  await page.getByTestId('learning-tool-tray').waitFor({ state: 'visible' });
  await page.getByTestId('learning-tool-tray').getByRole('button', { name: '拾光漫游', exact: true }).click();
  await waitState('boss');
  await installMotionObserver(page, motionBeforeRefresh);
  await settle('BOSS-2-RESTORED');
  const afterRefresh = await currentSnapshot();
  const routeAfterRefresh = await page.evaluate((runId) => ({
    raw: localStorage.getItem(`shiguang_manyou_route_${runId}`),
    scene: document.querySelector('.shiguang-overlay')?.dataset.sceneId || '',
    state: document.querySelector('.shiguang-overlay')?.dataset.state || '',
  }), started.run_id);
  check('refresh restores same run, narrative, route, station and boss stage',
    afterRefresh.run_id === beforeRefresh.run_id
      && JSON.stringify(afterRefresh.narrative) === JSON.stringify(beforeRefresh.narrative)
      && routeAfterRefresh.raw === routeBeforeRefresh.raw
      && routeAfterRefresh.scene === routeBeforeRefresh.scene
      && routeAfterRefresh.state === routeBeforeRefresh.state
      && afterRefresh.archive.boss_stage === 2,
    { before: { snapshot: publicSnapshot(beforeRefresh), route: routeBeforeRefresh }, after: { snapshot: publicSnapshot(afterRefresh), route: routeAfterRefresh } });
  await shot('09-refresh-restored.png');

  const bossTransferTask = started.content.boss[2];
  let bossStageTwoSolved = false;
  const bossStageTwoAttempts = bossTransferTask.type === 'multiple_choice' ? bossTransferTask.options.length : 3;
  for (let rank = 0; rank < bossStageTwoAttempts && !bossStageTwoSolved; rank += 1) {
    await submitVisibleAnswer(page, bossTransferTask, `${started.content.scroll.rule} ${bossTransferTask.hint || ''}`, rank);
    await settle(`BOSS-2-ATTEMPT-${rank + 1}`);
    bossStageTwoSolved = (await currentSnapshot()).state === 'TREASURY';
    if (!bossStageTwoSolved) {
      await requestVisibleHint(page);
    }
  }
  check('BOSS transfer stage is completed through visible answer', bossStageTwoSolved);

  if (false) {
  const bossTransferQuestion = bossTransferTask.question || '';
  const bossTransferAnswer = /生成器/.test(bossTransferQuestion)
    ? '数据量大且只需逐项处理时使用生成器惰性迭代；需要重复索引或立即得到全部结果时使用列表，并比较内存与访问方式。'
    : /列表推导式|range\(10\)|i % 3/.test(bossTransferQuestion)
      ? 'result = [i*2 for i in range(10) if i % 3 == 0]，先确认条件，再验证生成结果。'
    : semanticAnswer(bossTransferTask, '先确认适用条件，再按步骤应用，并用一个新例子验证结果。');
  await submitTask(page, bossTransferTask, bossTransferAnswer);
  }
  await waitState('treasury');
  await settle('TREASURY');
  const treasuryDialogue = Object.entries(dialogueByState)
    .filter(([label]) => label.startsWith('BOSS-2') || label.startsWith('TREASURY'))
    .flatMap(([, lines]) => lines || []);
  check('TREASURY uses resolution state_copy', treasuryDialogue.some((line) => line.text === started.narrative.state_copy.resolution), treasuryDialogue);
  await shot('10-treasury.png');
  const collectResponsePromise = page.waitForResponse((response) => response.url().includes('/api/adventure/advance')
    && response.request().method() === 'POST', { timeout: 90_000 });
  await action('reward-collect');
  const collectResponse = await collectResponsePromise;
  check('visible reward collection uses the real advance endpoint', collectResponse.ok(), { status: collectResponse.status() });
  const completed = (await collectResponse.json()).data;
  await waitState('completed');
  await settle('COMPLETED');
  check('reward collection reaches completed', completed.state === 'completed' && Boolean(completed.artifact_id), publicSnapshot(completed));
  await shot('11-completed.png');

  await page.waitForTimeout(4200);
  motionEvidence = await page.evaluate(() => window.__ultimate08MotionEvidence || []);
  const enemyStates = new Set(motionEvidence.map((item) => item.enemy).filter(Boolean));
  const spellStates = new Set(motionEvidence.map((item) => item.spell).filter(Boolean));
  check('enemy lifecycle is visibly exercised', ['entering', 'reacting', 'hit', 'staggered', 'defeated_pose', 'dissolving']
    .filter((state) => enemyStates.has(state)).length >= 4, { enemyStates: [...enemyStates] });
  check('spell lifecycle is visibly exercised', spellStates.size >= 3, { spellStates: [...spellStates] });
  check('horizon fireworks scene and celebration are visible', motionEvidence.some((item) => item.scene === 'fireworks_ready')
    && motionEvidence.some((item) => item.celebration), motionEvidence.slice(-12));

  const rewardTile = page.locator('[data-action="reward-detail"]').first();
  await rewardTile.click();
  const equipButton = page.locator('[data-action="reward-equip"]');
  await equipButton.waitFor({ state: 'visible' });
  const equipResponse = page.waitForResponse((response) => response.url().includes('/api/adventure/rewards/equip') && response.request().method() === 'POST');
  await equipButton.click();
  check('active reward equip uses the real endpoint', (await equipResponse).ok());
  await shot('12-reward-equipped-fireworks.png');

  await action('return');
  await page.locator('.shiguang-overlay').waitFor({ state: 'detached' });
  check('visible return control restores the same AI learning workspace', await page.locator('#messages').isVisible());
  await shot('13-return-to-ai-learning.png');

  if (false) {
  const legacyStart = await context.request.post(`${base}/api/adventure/start`, {
    headers,
    data: {
      topic: '机器学习模型评估', magic_school: 'wood', source_ids: [], source_type: 'manual',
      force_new: true, prepared_plan_id: null,
    },
  });
  check('legacy direct start succeeds without Narrative', legacyStart.ok(), { status: legacyStart.status() });
  const legacySnapshot = (await legacyStart.json()).data;
  check('legacy direct start exposes narrative null fallback', legacySnapshot.narrative === null, publicSnapshot(legacySnapshot));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#adventureEntry').waitFor({ state: 'visible' });
  await page.locator('#adventureEntry').click();
  await waitState('goal');
  await settle('LEGACY-GOAL');
  const fallbackDestinations = await page.locator('[data-action="destination"][data-destination-kind="travel"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.destinationId));
  check('legacy static fallback keeps usable registered destinations',
    fallbackDestinations.length >= 2 && fallbackDestinations.every((id) => window.KakiAdventureSceneRegistry?.has(id)),
    fallbackDestinations);
  await shot('12-legacy-static-fallback.png');
  }

  check('browser console has no blocking errors', consoleErrors.length === 0, consoleErrors);
  check('browser network has no 4xx/5xx or failed requests', networkErrors.length === 0, networkErrors);
} catch (error) {
  checks.push({ name: 'unhandled browser closeout error', pass: false, details: error.stack || error.message });
  try { await shot('99-failure.png'); } catch (_) {}
}

const report = {
  status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL',
  formal_url: formalUrl,
  user: { user_id: registered.user_id, username },
  checks,
  dialogue_by_state: dialogueByState,
  motion_evidence: motionEvidence,
  adventure_requests: adventureRequests,
  console_errors: consoleErrors,
  page_errors: pageErrors,
  network_errors: networkErrors,
  screenshots,
  video_markers: videoMarkers,
};
await writeFile(path.join(output, 'browser-closeout-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
await context.close();
if (recordVideo && recordedPageVideo) {
  await recordedPageVideo.saveAs(path.join(output, 'KAKI-ADVENTURE-FULL-REAL-BROWSER.webm'));
}
await browser.close();
process.exitCode = report.status === 'PASS' ? 0 : 1;
