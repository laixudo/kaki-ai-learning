/* global console, document, getComputedStyle, localStorage, performance, process, window */

import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.env.KAKI_ENEMY_EVIDENCE
  || path.join(projectRoot, 'evidence/game-enemy-companion-20260731');
const viewports = {
  wide: { width: 1920, height: 1080, label: '1920x1080' },
  standard: { width: 1440, height: 900, label: '1440x900' },
  compact: { width: 1366, height: 768, label: '1366x768' },
};

await mkdir(output, { recursive: true });

const stamp = Date.now();
const username = `enemy_companion_${stamp}`;
const password = 'EnemyCompanion!2026';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: viewports.wide, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(12_000);

const checks = [];
const screenshots = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];

function check(name, condition, detail = '') {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) throw new Error(`${name}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
}

async function capture(name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  screenshots.push(file);
}

page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text());
    console.error('[browser console]', message.text());
  }
});
page.on('pageerror', (error) => {
  pageErrors.push(error.message);
  console.error('[browser pageerror]', error.message);
});
page.on('response', (response) => {
  if (response.status() >= 500) failedResponses.push({ status: response.status(), url: response.url() });
});

await page.addInitScript(() => {
  window.__kakiEnemyEvents = [];
  window.addEventListener('shiguang:enemy', (event) => {
    window.__kakiEnemyEvents.push({ ...event.detail, at: performance.now() });
  });
});

const register = await context.request.post(`${base}/api/auth/register`, {
  data: { username, password, email: `${username}@example.test` },
});
check('real-registration-http-200', register.ok(), String(register.status()));
const account = (await register.json()).data;
const authHeaders = { Authorization: `Bearer ${account.token}` };
const onboardingStart = await context.request.post(`${base}/api/profile-onboarding/start`, {
  headers: authHeaders,
});
check('real-onboarding-start-http-200', onboardingStart.ok(), String(onboardingStart.status()));
const onboardingTask = (await onboardingStart.json()).data;
const onboardingSkip = await context.request.post(`${base}/api/profile-onboarding/skip`, {
  headers: authHeaders,
  data: { task_id: onboardingTask.task_id },
});
check('real-onboarding-skip-http-200', onboardingSkip.ok(), String(onboardingSkip.status()));

await page.addInitScript(({ token, userId, name }) => {
  const user = {
    userId,
    username: name,
    email: `${name}@example.test`,
    avatarUrl: null,
    hasProfile: true,
  };
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(userId));
  localStorage.setItem('ml_user', JSON.stringify({
    id: userId,
    user_id: userId,
    username: name,
    nickname: name,
    email: user.email,
  }));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: account.token, userId: account.user_id, name: username });

async function waitForGameState(expected, timeout = 20_000) {
  await page.waitForFunction(
    (state) => document.querySelector('.shiguang-overlay')?.getAttribute('data-state') === state,
    expected,
    { timeout },
  );
}

async function dialogueSnapshot() {
  return page.evaluate(() => {
    const dialogue = document.querySelector('.shiguang-dialogue');
    if (!dialogue) return null;
    return {
      index: Number(dialogue.getAttribute('data-queue-index') || 0),
      complete: dialogue.getAttribute('data-line-complete') === 'true',
      speakerType: dialogue.getAttribute('data-speaker-type') || '',
      text: dialogue.querySelector('[data-dialogue-text]')?.textContent || '',
    };
  });
}

async function drainDialogue() {
  let turns = 0;
  while (await page.locator('.shiguang-dialogue').count()) {
    turns += 1;
    if (turns > 30) throw new Error('dialogue queue did not finish');
    await page.locator('[data-action="dialogue-next"]').click();
    await page.waitForTimeout(80);
  }
}

async function collectDialogueTexts() {
  const texts = [];
  let turns = 0;
  while (await page.locator('.shiguang-dialogue').count()) {
    turns += 1;
    if (turns > 30) throw new Error('dialogue queue did not finish');
    const before = await dialogueSnapshot();
    if (before?.text) texts.push({ speakerType: before.speakerType, text: before.text });
    await page.locator('[data-action="dialogue-next"]').click();
    await page.waitForTimeout(80);
    if (!before?.complete) {
      const completed = await dialogueSnapshot();
      if (completed?.text) texts.push({ speakerType: completed.speakerType, text: completed.text });
    }
  }
  return texts;
}

async function chooseDestination(destinationId = '') {
  try {
    await page.waitForSelector('.shiguang-dialogue');
  } catch (error) {
    console.error('[dialogue debug]', await page.evaluate(() => ({
      state: document.querySelector('.shiguang-overlay')?.getAttribute('data-state'),
      phase: document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase'),
      transition: document.querySelector('.shiguang-overlay')?.getAttribute('data-transition-kind'),
      panel: document.querySelector('.shiguang-panel')?.innerHTML,
      scene: document.querySelector('.shiguang-scene')?.getAttribute('data-scene-location'),
    })));
    throw error;
  }
  await drainDialogue();
  const selector = destinationId
    ? `[data-action="destination"][data-destination-id="${destinationId}"]`
    : '[data-action="destination"][data-destination-kind="stay"]';
  await page.locator(selector).click();
  await page.waitForSelector('.shiguang-dialogue');
  await drainDialogue();
}

async function continueAtState(state) {
  await waitForGameState(state);
  await chooseDestination();
}

async function waitForEnemyState(state, timeout = 12_000) {
  await page.waitForFunction(
    (value) => document.querySelector('[data-enemy-root]')?.getAttribute('data-enemy-state') === value,
    state,
    { timeout },
  );
}

async function currentEnemyEvents() {
  return page.evaluate(() => window.__kakiEnemyEvents || []);
}

async function layoutCheck(viewport) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(160);
  return page.evaluate(() => {
    const enemy = document.querySelector('[data-enemy-root]')?.getBoundingClientRect();
    const mascot = document.querySelector('.shiguang-mascot')?.getBoundingClientRect();
    const panel = document.querySelector('.shiguang-panel')?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      enemy: enemy && { left: enemy.left, right: enemy.right, top: enemy.top, bottom: enemy.bottom },
      mascot: mascot && { left: mascot.left, right: mascot.right, top: mascot.top, bottom: mascot.bottom },
      panel: panel && { top: panel.top, bottom: panel.bottom },
    };
  });
}

await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
check(
  'enemy-director-runtime-loaded',
  await page.evaluate(() => Boolean(window.KakiAdventureEnemyDirector)),
);

const assistantBefore = await page.locator('#messages .msg.assistant').count();
await page.locator('#input').fill('请用一句话说明验证集和测试集的区别。');
const chatResponsePromise = page.waitForResponse(
  (response) => response.url().includes('/api/chat/stream') && response.request().method() === 'POST',
  { timeout: 60_000 },
);
await page.locator('#send').click();
const chatResponse = await chatResponsePromise;
await page.waitForFunction(
  (count) => document.querySelectorAll('#messages .msg.assistant').length > count
    && !document.querySelector('#send')?.disabled,
  assistantBefore,
  { timeout: 60_000 },
);
check('ordinary-ai-chat-real-stream', chatResponse.status() === 200, String(chatResponse.status()));

await page.locator('#adventureEntry').click();
await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
await page.locator('#shiguangTopic').fill('机器学习模型评估');
await page.locator('input[name="source"][value="manual"]').check();
await page.locator('.shiguang-schools label[data-school="wood"]').click();
await page.locator('[data-action="confirm-school"]').click();
await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
await page.locator('[data-action="start"]').click();
await waitForGameState('goal');
await chooseDestination('echo_archive');
await page.locator('[data-action="continue"]').click();
await continueAtState('scroll');
await page.locator('[data-action="continue"]').click();
await continueAtState('method');
await page.locator('[data-action="method"][data-method="explain"]').click();

await waitForEnemyState('foreshadow');
check('enemy-foreshadow-precedes-visible-enemy', await page.locator('[data-enemy-foreshadow]').isVisible());
await capture('01-enemy-foreshadow');
await waitForEnemyState('entering');
check('enemy-enters-from-scene-causal-anchor', Boolean(await page.locator('[data-enemy-root]').getAttribute('data-entry-style')));
await page.waitForSelector('.shiguang-dialogue');
const misconceptionLines = await collectDialogueTexts();
const misconceptionText = [
  ...misconceptionLines.filter((line) => line.speakerType === 'enemy').map((line) => line.text),
  await page.locator('[data-enemy-root]').getAttribute('data-misconception'),
].filter(Boolean);
check(
  'enemy-states-specific-misconception-before-interaction',
  misconceptionText.join('').includes('未见') || misconceptionText.join('').includes('训练'),
  misconceptionText,
);
await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
await page.waitForSelector('.shiguang-dialogue');
await drainDialogue();
check('challenge-unlocks-only-after-dialogue', await page.locator('.shiguang-answer textarea').isVisible());
await capture('02-enemy-entry-and-misconception');

const wrongAnswer = '训练分数高就说明模型一定学会了。';
await page.locator('.shiguang-answer textarea').fill(wrongAnswer);
const wrongResponsePromise = page.waitForResponse(
  (response) => response.url().includes('/api/adventure/advance') && response.request().method() === 'POST',
);
await page.locator('.shiguang-answer button[type="submit"]').click();
const wrongResponse = await wrongResponsePromise;
check('wrong-answer-uses-real-backend-result', wrongResponse.status() === 200, String(wrongResponse.status()));
await waitForEnemyState('reacting');
const wrongEvents = await currentEnemyEvents();
check('wrong-answer-never-enters-full-hit', !wrongEvents.some((event) => event.state === 'hit'));
check('wrong-answer-never-enters-defeated-pose', !wrongEvents.some((event) => event.state === 'defeated_pose'));
await capture('03-wrong-answer-fizzle');
await waitForGameState('supply');
await chooseDestination();
check('wrong-answer-is-visibly-preserved', (await page.locator('[data-preserved-answer]').innerText()).includes('训练分数高'));
check('companion-support-references-real-gap', (await page.locator('.shiguang-panel').innerText()).includes('证据'));
check('retry-interaction-reopens-after-wrong-answer', await page.locator('.shiguang-options button').first().isEnabled());
await capture('04-companion-wrong-answer-support');

await page.locator('.shiguang-options button').first().click();
await continueAtState('interleave');
check('remediation-success-keeps-real-correction-history', await page.locator('.shiguang-overlay').getAttribute('data-had-correction') === 'true');

await page.locator('.shiguang-options button').first().click();
await waitForEnemyState('hit');
const hitBox = await page.locator('[data-enemy-root]').boundingBox();
const impactBox = await page.locator('.shiguang-spell-impact').boundingBox();
check(
  'spell-impact-aligns-with-enemy-anchor',
  hitBox && impactBox
    && impactBox.x + impactBox.width / 2 >= hitBox.x
    && impactBox.x + impactBox.width / 2 <= hitBox.x + hitBox.width,
  { hitBox, impactBox },
);
await capture('05-normal-enemy-hit');
await waitForEnemyState('defeated_pose');
check('normal-enemy-keeps-recognisable-defeated-asset', (await page.locator('[data-enemy-root]').getAttribute('src') || '').includes('enemy_inkbeast_defeated'));
check('reward-is-not-visible-during-defeated-pose', await page.locator('[data-reward-candidate]').count() === 0);
await capture('06-normal-enemy-defeated');
await waitForEnemyState('transforming');
check('normal-enemy-transforms-into-knowledge-result', await page.locator('[data-knowledge-result]').isVisible());
await capture('07-normal-knowledge-transformation');

await waitForGameState('boss', 30_000);
await chooseDestination();
check('boss-starts-at-real-backend-stage-zero', await page.locator('.shiguang-overlay').getAttribute('data-boss-stage') === '0');
await page.locator('[data-action="hint"]').click();
await waitForGameState('boss');
await page.waitForSelector('.shiguang-dialogue');
await drainDialogue();
check('actual-hint-use-is-recorded-for-presentation', await page.locator('.shiguang-overlay').getAttribute('data-hint-used') === 'true');
await page.locator('.shiguang-answer textarea').fill('泛化能力是模型在未见新数据上的预测表现。');
await page.locator('.shiguang-answer button[type="submit"]').click();
await waitForEnemyState('phase_changed');
check('boss-phase-one-follows-real-stage-field', await page.locator('[data-enemy-root]').getAttribute('data-boss-stage') === '1');
await capture('08-boss-phase-one');

await waitForGameState('boss');
await page.waitForSelector('.shiguang-dialogue');
await drainDialogue();
await page.locator('.shiguang-options button').first().click();
await waitForEnemyState('phase_changed');
check('boss-core-exposed-follows-real-stage-two', await page.locator('[data-enemy-root]').getAttribute('data-boss-stage') === '2');
await capture('09-boss-core-exposed');

const brokenBoss = page.locator('[data-enemy-root]');
await brokenBoss.evaluate((image) => { image.src = '/ai-workspace/assets/adventure/characters/not-found.png'; });
await page.waitForSelector('[data-enemy-fallback]:not([hidden])');
check('enemy-asset-failure-uses-restrained-fallback', await brokenBoss.isHidden() && await page.locator('[data-enemy-fallback]').isVisible());

await page.locator('[data-action="leave"]').click();
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#adventureEntry').click();
await waitForGameState('boss');
check('refresh-restores-real-boss-stage', await page.locator('[data-enemy-root]').getAttribute('data-boss-stage') === '2');
check('refresh-does-not-replay-completed-spell', await page.locator('.shiguang-spell-fx').count() === 0);
check('global-companion-remains-hidden-during-game', await page.getByTestId('mascot-companion').getAttribute('data-state') === 'hidden');
check('game-has-only-one-companion', await page.locator('.shiguang-mascot').count() === 1);

await page.emulateMedia({ reducedMotion: 'reduce' });
await page.locator('.shiguang-answer textarea').waitFor({ state: 'visible' });
await page.locator('.shiguang-answer textarea').fill('这是过拟合，我会使用早停来改善泛化。');
await page.locator('.shiguang-answer button[type="submit"]').click();
await waitForEnemyState('defeated_pose');
check('boss-keeps-recognisable-defeated-pose', (await page.locator('[data-enemy-root]').getAttribute('src') || '').includes('boss_moyan_master_defeated'));
await capture('10-boss-defeated-aftermath');
await waitForEnemyState('transforming');
check('boss-transforms-into-knowledge-core-seal', (await page.locator('[data-knowledge-result] img').getAttribute('src') || '').includes('knowledge_core_seal'));
check('quiet-aftermath-precedes-reward', await page.locator('[data-aftermath]').isVisible() && await page.locator('[data-reward-candidate]').count() === 0);
check(
  'reduced-motion-still-completes-final-flow',
  await page.locator('[data-enemy-root]').evaluate((node) => (
    node.getAttribute('data-enemy-state') === 'transforming'
    && getComputedStyle(node).animationName === 'none'
  )),
);
await capture('11-boss-transformation-aftermath');

await waitForGameState('treasury', 30_000);
await page.waitForSelector('.shiguang-dialogue');
await drainDialogue();
check('transformed-result-remains-visible-in-treasury', await page.locator('[data-knowledge-result]').isVisible());
const aftermathText = await page.locator('.shiguang-panel').innerText();
check('aftermath-recognition-cites-correction-and-hint', aftermathText.includes('修正') && aftermathText.includes('线索'), aftermathText);
check('aftermath-contains-no-profile-or-affinity-terms', !/(好感度|认可值|关系等级|掌握度|用户画像|数据已记录)/.test(aftermathText));

for (const viewport of Object.values(viewports)) {
  const metrics = await layoutCheck(viewport);
  check(
    `${viewport.label}-enemy-companion-layout-safe`,
    metrics.scrollWidth <= metrics.clientWidth + 2
      && (!metrics.enemy || metrics.enemy.left >= -2 && metrics.enemy.right <= viewport.width + 2)
      && (!metrics.mascot || metrics.mascot.left >= -2 && metrics.mascot.right <= viewport.width + 2),
    metrics,
  );
}

await page.locator('[data-action="reward-collect-equip"]').click();
await waitForGameState('completed', 30_000);
await page.waitForSelector('.shiguang-dialogue');
await drainDialogue();
check('reward-and-equipment-real-chain-completes', (await page.locator('.shiguang-panel').innerText()).includes('当前装备'));
check('fireworks-minimum-regression-remains-visible', await page.locator('.shiguang-celebration-bursts').isVisible());

await page.locator('[data-action="leave"]').click();
await page.waitForFunction(() => {
  const companion = document.querySelector('[data-testid="mascot-companion"]');
  return companion && companion.getAttribute('data-state') !== 'hidden'
    && getComputedStyle(companion).visibility !== 'hidden';
});
check('leaving-game-restores-global-companion', await page.getByTestId('mascot-companion').isVisible());

check('no-console-errors', consoleErrors.length === 0, consoleErrors);
check('no-page-errors', pageErrors.length === 0, pageErrors);
check('no-5xx-responses', failedResponses.length === 0, failedResponses);

const resources = [];
for (const relative of [
  'frontend/public/ai-workspace/assets/adventure/characters/enemy_inkbeast_defeated.png',
  'frontend/public/ai-workspace/assets/adventure/characters/boss_moyan_master_defeated.png',
  'frontend/public/ai-workspace/assets/adventure/items/knowledge_seed.png',
  'frontend/public/ai-workspace/assets/adventure/items/knowledge_core_seal.png',
]) {
  const full = path.join(projectRoot, relative);
  const buffer = await readFile(full);
  const info = await stat(full);
  resources.push({
    path: relative.replaceAll(path.sep, '/'),
    bytes: info.size,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  });
}
await writeFile(
  path.join(output, 'enemy-resource-manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), resources }, null, 2)}\n`,
  'utf8',
);

const report = {
  status: 'PASS',
  generatedAt: new Date().toISOString(),
  checks,
  total: checks.length,
  passed: checks.filter((item) => item.passed).length,
  screenshots,
  consoleErrors,
  pageErrors,
  failedResponses,
  enemyEvents: await currentEnemyEvents(),
};
await writeFile(
  path.join(output, 'game-enemy-companion-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);

console.log(JSON.stringify({
  status: report.status,
  total: report.total,
  passed: report.passed,
  screenshots: screenshots.length,
  output,
}, null, 2));

await browser.close();
