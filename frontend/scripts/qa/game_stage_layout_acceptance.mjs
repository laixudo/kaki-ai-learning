/* global console, document, getComputedStyle, localStorage, process */

import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const output = process.env.KAKI_STAGE_EVIDENCE || path.resolve('evidence/game-stage-layout-20260729');
const viewports = [
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1366, height: 768, label: '1366x768' },
];

await mkdir(output, { recursive: true });

const stamp = new Date().toISOString().replace(/\D/g, '');
const username = `stage_layout_${stamp}`;
const password = 'StageLayout!2026';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: viewports[0],
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const checks = [];
const layouts = [];

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 500) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});

const register = await context.request.post(`${base}/api/auth/register`, {
  data: {
    username,
    password,
    email: `${username}@example.test`,
  },
});
if (!register.ok()) {
  throw new Error(`register returned ${register.status()}: ${await register.text()}`);
}

const registered = (await register.json()).data;
const authHeaders = { Authorization: `Bearer ${registered.token}` };
const onboardingStart = await context.request.post(`${base}/api/profile-onboarding/start`, {
  headers: authHeaders,
});
if (!onboardingStart.ok()) {
  throw new Error(`profile onboarding start returned ${onboardingStart.status()}: ${await onboardingStart.text()}`);
}
const onboardingTask = (await onboardingStart.json()).data;
const onboardingSkip = await context.request.post(`${base}/api/profile-onboarding/skip`, {
  headers: authHeaders,
  data: { task_id: onboardingTask.task_id },
});
if (!onboardingSkip.ok()) {
  throw new Error(`profile onboarding skip returned ${onboardingSkip.status()}: ${await onboardingSkip.text()}`);
}
const currentUser = await context.request.get(`${base}/api/auth/me`, {
  headers: authHeaders,
});
if (!currentUser.ok()) {
  throw new Error(`auth/me returned ${currentUser.status()}: ${await currentUser.text()}`);
}
const currentUserPayload = (await currentUser.json()).data;
if (!currentUserPayload.has_profile) {
  throw new Error('real profile onboarding did not produce an authenticated completed profile');
}
const user = {
  userId: registered.user_id,
  username,
  email: `${username}@example.test`,
  avatarUrl: null,
  hasProfile: Boolean(currentUserPayload.has_profile),
};

await page.addInitScript(({ token, storedUser }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(storedUser));
  localStorage.setItem('ml_current_user_id', String(storedUser.userId));
  localStorage.setItem('ml_user', JSON.stringify({
    id: storedUser.userId,
    user_id: storedUser.userId,
    username: storedUser.username,
    nickname: storedUser.username,
    email: storedUser.email,
  }));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: registered.token, storedUser: user });

function check(name, condition, detail) {
  checks.push({ name, passed: Boolean(condition), detail });
}

async function waitForState(expected) {
  await page.waitForFunction(
    (value) => document.querySelector('.shiguang-overlay')?.getAttribute('data-state') === value,
    expected,
  );
}

async function drainDialogue() {
  let turns = 0;
  while (await page.locator('.shiguang-dialogue').count()) {
    turns += 1;
    if (turns > 24) throw new Error('dialogue queue did not finish');
    const dialogue = page.locator('.shiguang-dialogue');
    const index = Number(await dialogue.getAttribute('data-queue-index') || 0);
    const complete = await dialogue.getAttribute('data-line-complete') === 'true';
    await page.locator('[data-action="dialogue-next"]').click();
    await page.waitForFunction(
      ({ priorIndex, wasComplete }) => {
        const current = document.querySelector('.shiguang-dialogue');
        if (!current) return true;
        const nextIndex = Number(current.getAttribute('data-queue-index'));
        return wasComplete
          ? nextIndex > priorIndex
          : nextIndex === priorIndex && current.getAttribute('data-line-complete') === 'true';
      },
      { priorIndex: index, wasComplete: complete },
    );
  }
}

async function revealInteractionAfterChoice(destinationId = '') {
  await page.waitForFunction(() => document.querySelector('.shiguang-dialogue'));
  await drainDialogue();
  const selector = destinationId
    ? `[data-action="destination"][data-destination-id="${destinationId}"]`
    : '[data-action="destination"][data-destination-kind="stay"]';
  await page.locator(selector).click();
  await page.waitForFunction(() => document.querySelector('.shiguang-dialogue'));
  await drainDialogue();
}

async function continueAtCurrentLocation(expectedState) {
  await waitForState(expectedState);
  await revealInteractionAfterChoice();
}

async function measureLayout(viewport, phase) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.evaluate(() => {
    const overlay = document.querySelector('.shiguang-overlay');
    const stage = document.querySelector('.shiguang-stage');
    if (overlay) overlay.scrollTop = 0;
    if (stage) stage.scrollTop = 0;
  });
  await page.waitForTimeout(220);

  const layout = await page.evaluate(() => {
    const overlay = document.querySelector('.shiguang-overlay');
    const head = document.querySelector('.shiguang-head');
    const stage = document.querySelector('.shiguang-stage');
    const scene = document.querySelector('.shiguang-scene');
    const panel = document.querySelector('.shiguang-panel');
    const credit = document.querySelector('.shiguang-credit');
    if (!overlay || !head || !stage || !scene || !panel || !credit) {
      throw new Error('拾光漫游舞台契约不完整');
    }

    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };

    const panelStyle = getComputedStyle(panel);
    return {
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
      },
      overlay: rect(overlay),
      head: rect(head),
      stage: rect(stage),
      scene: rect(scene),
      panel: rect(panel),
      credit: rect(credit),
      panelPosition: panelStyle.position,
      panelOverflowY: panelStyle.overflowY,
      panelBackground: panelStyle.background,
      workspaceActive: document.querySelector('#workspaceApp')?.getAttribute('data-shiguang-active'),
    };
  });

  layouts.push({ phase, label: viewport.label, ...layout });
  const tolerance = 2;
  check(
    `${phase} ${viewport.label} overlay fills viewport`,
    Math.abs(layout.overlay.left) <= tolerance
      && Math.abs(layout.overlay.top) <= tolerance
      && Math.abs(layout.overlay.width - viewport.width) <= tolerance
      && Math.abs(layout.overlay.height - viewport.height) <= tolerance,
    layout.overlay,
  );
  check(
    `${phase} ${viewport.label} HUD is lightweight`,
    layout.head.height <= 72,
    { height: layout.head.height },
  );
  check(
    `${phase} ${viewport.label} scene fills stage`,
    layout.scene.left <= layout.stage.left + tolerance
      && layout.scene.top <= layout.stage.top + tolerance
      && layout.scene.right >= layout.stage.right - tolerance
      && layout.scene.bottom >= layout.stage.bottom - tolerance,
    { scene: layout.scene, stage: layout.stage },
  );
  check(
    `${phase} ${viewport.label} dialogue is bottom overlay`,
    layout.panelPosition === 'absolute'
      && layout.panel.width >= viewport.width * 0.72
      && layout.panel.width <= viewport.width * 0.96
      && layout.panel.bottom <= layout.stage.bottom - 12
      && layout.panel.bottom >= layout.stage.bottom - 44
      && layout.panel.height <= layout.stage.height * 0.48,
    {
      position: layout.panelPosition,
      panel: layout.panel,
      stage: layout.stage,
    },
  );
  check(
    `${phase} ${viewport.label} dialogue scrolls internally`,
    ['auto', 'scroll'].includes(layout.panelOverflowY),
    { overflowY: layout.panelOverflowY },
  );
  check(
    `${phase} ${viewport.label} has no horizontal overflow`,
    layout.viewport.scrollWidth <= layout.viewport.width + tolerance,
    layout.viewport,
  );
  check(
    `${phase} ${viewport.label} hides workspace behind game`,
    layout.workspaceActive === 'true',
    { workspaceActive: layout.workspaceActive },
  );

  await page.screenshot({
    path: path.join(output, `${phase}-${viewport.label}.png`),
    fullPage: false,
  });
  return layout;
}

await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
const assistantCountBeforeChat = await page.locator('#messages .msg.assistant').count();
await page.locator('#input').fill('用一句话解释过拟合。');
const [chatResponse] = await Promise.all([
  page.waitForResponse((response) => response.url().includes('/api/chat/stream'), { timeout: 60_000 }),
  page.locator('#send').click(),
]);
check('ordinary chat uses the real stream endpoint', chatResponse.status() === 200, {
  status: chatResponse.status(),
  url: chatResponse.url(),
});
await page.waitForFunction(
  (count) => document.querySelectorAll('#messages .msg.assistant').length > count
    && !document.querySelector('#send')?.disabled,
  assistantCountBeforeChat,
  { timeout: 120_000 },
);
const assistantCountAfterChat = await page.locator('#messages .msg.assistant').count();
const latestAnswer = await page.locator('#messages .msg.assistant .message-bubble').last().innerText();
check('ordinary chat renders a real answer', latestAnswer.trim().length >= 8, {
  length: latestAnswer.trim().length,
  preview: latestAnswer.trim().slice(0, 80),
});
await page.locator('#input').fill('舞台验收后仍需保留的聊天草稿');
await page.locator('#adventureEntry').click();
await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });

for (const viewport of viewports) {
  await measureLayout(viewport, 'prepare');
}

await page.setViewportSize({ width: 1440, height: 900 });
await page.locator('#shiguangTopic').fill('机器学习模型评估');
await page.locator('input[name="source"][value="manual"]').check();
await page.locator('.shiguang-schools label[data-school="wood"]').click();
await page.locator('[data-action="confirm-school"]').click();
await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
await page.locator('[data-action="start"]').click();
await waitForState('goal');
await revealInteractionAfterChoice('echo_archive');
const goalLayout = await measureLayout(viewports[1], 'goal');

const player = await page.locator('.shiguang-player').boundingBox();
const mascot = await page.locator('.shiguang-mascot').boundingBox();
check(
  'goal characters keep faces above dialogue',
  player && mascot
    && player.y < goalLayout.panel.top - 20
    && mascot.y < goalLayout.panel.top - 20,
  { player, mascot, dialogueTop: goalLayout.panel.top },
);

await page.locator('[data-action="continue"]').click();
await continueAtCurrentLocation('scroll');
await page.locator('[data-action="continue"]').click();
await continueAtCurrentLocation('method');
await page.locator('[data-action="method"][data-method="practice"]').click();
await continueAtCurrentLocation('trial');
const trialLayout = await measureLayout(viewports[2], 'trial');
const enemy = await page.locator('.shiguang-enemy').boundingBox();
check(
  'enemy keeps a stable visible position above dialogue',
  enemy
    && enemy.x > viewports[2].width * 0.55
    && enemy.y < trialLayout.panel.top - 10
    && enemy.x + enemy.width <= viewports[2].width + 2,
  { enemy, dialogueTop: trialLayout.panel.top },
);

const option = page.locator('.shiguang-options button').first();
check('trial option is visible and enabled', await option.isVisible() && await option.isEnabled(), {});
await option.click();
await continueAtCurrentLocation('supply');
await page.locator('[data-action="continue"]').click();
await continueAtCurrentLocation('interleave');

const answer = page.locator('.shiguang-answer textarea');
await answer.fill('我会用正则化减少过拟合');
check('text answer accepts user input', await answer.inputValue() === '我会用正则化减少过拟合', {});
check('submit action is enabled', await page.locator('.shiguang-answer button[type="submit"]').isEnabled(), {});

await page.locator('[data-action="leave"]').click();
check('leaving removes game overlay', await page.locator('.shiguang-overlay').count() === 0, {});
check(
  'leaving restores chat draft',
  await page.locator('#input').inputValue() === '舞台验收后仍需保留的聊天草稿',
  { value: await page.locator('#input').inputValue() },
);
check(
  'leaving keeps the current chat session visible',
  await page.locator('#messages .msg.assistant').count() >= assistantCountAfterChat,
  { beforeGame: assistantCountAfterChat, afterGame: await page.locator('#messages .msg.assistant').count() },
);

await page.locator('#adventureEntry').click();
await waitForState('interleave');
check('reopening preserves current game state', true, { state: 'interleave' });
await page.locator('[data-action="leave"]').click();

await page.reload({ waitUntil: 'networkidle' });
await page.locator('#adventureEntry').click();
await waitForState('interleave');
check('refresh preserves current game state', true, { state: 'interleave' });
await page.locator('[data-action="leave"]').click();

const failedChecks = checks.filter((item) => !item.passed);
const report = {
  status: failedChecks.length || consoleErrors.length || pageErrors.length || failedResponses.length ? 'FAIL' : 'PASS',
  frontendUrl: base,
  username,
  checks,
  failedChecks,
  layouts,
  consoleErrors,
  pageErrors,
  failedResponses,
};

await writeFile(
  path.join(output, 'game-stage-layout-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exitCode = report.status === 'PASS' ? 0 : 1;
