/* global console, document, getComputedStyle, performance, process, URL, window */

import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.env.KAKI_DIRECTION_EVIDENCE
  || path.join(projectRoot, 'evidence/game-scene-direction-20260729');
const viewports = {
  wide: { width: 1920, height: 1080, label: '1920x1080' },
  standard: { width: 1440, height: 900, label: '1440x900' },
  compact: { width: 1366, height: 768, label: '1366x768' },
};

await mkdir(output, { recursive: true });

const stamp = new Date().toISOString().replace(/\D/g, '');
const username = `scene_direction_${stamp}`;
const password = 'SceneDirection!2026';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: viewports.wide,
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const checks = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const advanceRequests = [];

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 500) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});
page.on('request', (request) => {
  if (request.method() === 'POST' && request.url().includes('/api/adventure/advance')) {
    advanceRequests.push({ url: request.url(), at: Date.now() });
  }
});

await page.addInitScript(() => {
  window.__kakiDirectionEvents = [];
  document.addEventListener('shiguang:direction', (event) => {
    window.__kakiDirectionEvents.push({
      ...event.detail,
      at: performance.now(),
    });
  });
});

function check(name, condition, detail = {}) {
  checks.push({ name, passed: Boolean(condition), detail });
}

async function registerRealUser() {
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
  const headers = { Authorization: `Bearer ${registered.token}` };
  const onboardingStart = await context.request.post(`${base}/api/profile-onboarding/start`, { headers });
  if (!onboardingStart.ok()) {
    throw new Error(`profile onboarding start returned ${onboardingStart.status()}`);
  }
  const onboardingTask = (await onboardingStart.json()).data;
  const onboardingSkip = await context.request.post(`${base}/api/profile-onboarding/skip`, {
    headers,
    data: { task_id: onboardingTask.task_id },
  });
  if (!onboardingSkip.ok()) {
    throw new Error(`profile onboarding skip returned ${onboardingSkip.status()}`);
  }
  const current = await context.request.get(`${base}/api/auth/me`, { headers });
  if (!current.ok()) throw new Error(`auth/me returned ${current.status()}`);
  const currentData = (await current.json()).data;
  if (!currentData.has_profile) throw new Error('real onboarding did not complete the profile');
  return registered;
}

async function loginThroughRenderedForm() {
  await page.goto(`${base}/login?redirect=/ai-learning`, { waitUntil: 'networkidle' });
  await page.getByTestId('auth-phone').fill(username);
  await page.getByTestId('auth-password').fill(password);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/auth/login')),
    page.getByTestId('auth-submit').click(),
  ]);
  await page.waitForURL((url) => url.pathname === '/ai-learning', { timeout: 15_000 });
  await page.locator('#adventureEntry').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const send = document.querySelector('#send');
    return send && !send.disabled;
  });
  check('authentication completes through the rendered login form', loginResponse.status() === 200, {
    status: loginResponse.status(),
    path: new URL(page.url()).pathname,
  });
}

async function waitForState(expected, timeout = 12_000) {
  await page.waitForFunction(
    (state) => document.querySelector('.shiguang-overlay')?.getAttribute('data-state') === state,
    expected,
    { timeout },
  );
}

async function waitForPhase(expected, timeout = 5_000) {
  try {
    await page.waitForFunction(
      (phase) => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === phase,
      expected,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function dialogueState() {
  return page.evaluate(() => {
    const dialogue = document.querySelector('.shiguang-dialogue');
    if (!dialogue) return null;
    return {
      index: Number(dialogue.getAttribute('data-queue-index') || 0),
      length: Number(dialogue.getAttribute('data-queue-length') || 0),
      complete: dialogue.getAttribute('data-line-complete') === 'true',
      speakerType: dialogue.getAttribute('data-speaker-type') || '',
      text: dialogue.querySelector('[data-dialogue-text]')?.textContent || '',
    };
  });
}

async function exerciseClickSemantics() {
  const current = await dialogueState();
  if (!current) {
    check('dialogue queue exists before the first interaction', false);
    return;
  }

  const typingIndex = await page.evaluate(() => {
    let dialogue = document.querySelector('.shiguang-dialogue');
    let index = Number(dialogue?.getAttribute('data-queue-index') || 0);
    const length = Number(dialogue?.getAttribute('data-queue-length') || 0);
    if (dialogue?.getAttribute('data-line-complete') === 'true' && index < length - 1) {
      dialogue.querySelector('[data-action="dialogue-next"]')?.click();
      dialogue = document.querySelector('.shiguang-dialogue');
      index = Number(dialogue?.getAttribute('data-queue-index') || 0);
    }
    dialogue?.querySelector('[data-action="dialogue-next"]')?.click();
    return index;
  });
  await page.waitForFunction(
    (index) => {
      const dialogue = document.querySelector('.shiguang-dialogue');
      return Number(dialogue?.getAttribute('data-queue-index')) === index
        && dialogue?.getAttribute('data-line-complete') === 'true';
    },
    typingIndex,
  );
  const completed = await dialogueState();
  check(
    'one click completes the current line without advancing it',
    completed && completed.index === typingIndex && completed.complete,
    { before: current, after: completed },
  );

  await page.locator('[data-action="dialogue-next"]').click();
  await page.waitForFunction(
    (index) => {
      const dialogue = document.querySelector('.shiguang-dialogue');
      return !dialogue || Number(dialogue.getAttribute('data-queue-index')) === index + 1;
    },
    typingIndex,
  );
  const advanced = await dialogueState();
  check(
    'the next click advances exactly one line',
    !advanced || advanced.index === typingIndex + 1,
    { previousIndex: typingIndex, next: advanced },
  );
}

async function drainDialogue() {
  let turns = 0;
  while (await page.locator('.shiguang-dialogue').count()) {
    turns += 1;
    if (turns > 18) throw new Error('dialogue queue did not finish');
    const current = await dialogueState();
    await page.locator('[data-action="dialogue-next"]').click();
    if (current?.complete) {
      await page.waitForFunction(
        (index) => {
          const dialogue = document.querySelector('.shiguang-dialogue');
          return !dialogue || Number(dialogue.getAttribute('data-queue-index')) > index;
        },
        current.index,
      );
    } else {
      await page.waitForFunction(
        (index) => {
          const dialogue = document.querySelector('.shiguang-dialogue');
          return !dialogue
            || (Number(dialogue.getAttribute('data-queue-index')) === index
              && dialogue.getAttribute('data-line-complete') === 'true');
        },
        current?.index || 0,
      );
    }
  }
  return waitForPhase('interactive', 3_000);
}

async function stageSnapshot(name, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(180);
  const metrics = await page.evaluate(() => {
    const overlay = document.querySelector('.shiguang-overlay');
    const stage = document.querySelector('.shiguang-stage');
    const scenes = document.querySelectorAll('.shiguang-scene');
    const images = Array.from(document.querySelectorAll('.shiguang-scene img'));
    return {
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      phase: overlay?.getAttribute('data-direction-phase'),
      transitionKind: overlay?.getAttribute('data-transition-kind'),
      stageState: overlay?.getAttribute('data-state'),
      sceneCount: scenes.length,
      playerCount: document.querySelectorAll('.shiguang-player').length,
      mascotCount: document.querySelectorAll('.shiguang-mascot').length,
      enemyCount: document.querySelectorAll('.shiguang-enemy').length,
      stageHeight: stage?.getBoundingClientRect().height || 0,
      brokenImages: images.filter((image) => !image.complete || image.naturalWidth === 0).length,
    };
  });
  check(`${name} ${viewport.label} has no horizontal overflow`, metrics.scrollWidth <= metrics.viewportWidth + 2, metrics);
  check(`${name} ${viewport.label} has one stable scene`, metrics.sceneCount === 1, metrics);
  check(`${name} ${viewport.label} has no duplicate player or companion`, metrics.playerCount <= 1 && metrics.mascotCount === 1, metrics);
  check(`${name} ${viewport.label} has no broken character image`, metrics.brokenImages === 0, metrics);
  await page.screenshot({
    path: path.join(output, `${name}-${viewport.label}.png`),
    fullPage: false,
  });
  return metrics;
}

async function repeatedClick(selector) {
  const before = advanceRequests.length;
  await page.locator(selector).evaluate((element) => {
    element.click();
    element.click();
    element.click();
  });
  return before;
}

await registerRealUser();
await loginThroughRenderedForm();

const beforeAssistant = await page.locator('#messages .msg.assistant').count();
await page.locator('#input').fill('用一句话解释过拟合。');
const [chatResponse] = await Promise.all([
  page.waitForResponse((response) => response.url().includes('/api/chat/stream'), { timeout: 60_000 }),
  page.locator('#send').click(),
]);
await page.waitForFunction(
  (count) => document.querySelectorAll('#messages .msg.assistant').length > count
    && !document.querySelector('#send')?.disabled,
  beforeAssistant,
  { timeout: 120_000 },
);
check('ordinary chat uses the real stream endpoint', chatResponse.status() === 200, {
  status: chatResponse.status(),
});

await page.locator('#input').fill('导演验收后仍需保留的草稿');
await page.locator('#adventureEntry').click();
await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
const modalReceivedFocus = await page.waitForFunction(
  () => document.querySelector('.shiguang-overlay')?.contains(document.activeElement),
  null,
  { timeout: 3_000 },
).then(() => true).catch(() => false);
check(
  'opening the modal moves keyboard focus inside it',
  modalReceivedFocus,
);
await page.locator('#shiguangTopic').fill('机器学习模型评估');
await page.locator('input[name="source"][value="manual"]').check();
await page.locator('.shiguang-schools label[data-school="wood"]').click();
await page.locator('[data-action="confirm-school"]').click();
await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
await page.locator('[data-action="start"]').click();
await waitForState('goal');

const goalDialoguePhase = await waitForPhase('dialogue');
check('new journey enters a dialogue phase', goalDialoguePhase);
const dialogueReceivedFocus = await page.waitForFunction(
  () => document.activeElement?.getAttribute('data-action') === 'dialogue-next',
  null,
  { timeout: 2_000 },
).then(() => true).catch(() => false);
check(
  'dialogue keeps keyboard focus on its advance control',
  dialogueReceivedFocus,
);
const tabTrace = [];
for (let step = 0; step < 12; step += 1) {
  await page.keyboard.press('Tab');
  tabTrace.push(await page.evaluate(() => ({
    action: document.activeElement?.getAttribute('data-action') || '',
    insideModal: Boolean(document.querySelector('.shiguang-overlay')?.contains(document.activeElement)),
  })));
}
check(
  'keyboard tab cycle stays inside the modal and skips inactive travel controls',
  tabTrace.every((item) => item.insideModal && item.action !== 'skip-transition'),
  { tabTrace },
);
await page.locator('[data-action="dialogue-next"]').focus();
check(
  'formal goal interaction is hidden until dialogue finishes',
  await page.locator('[data-action="continue"]').count() === 0,
);
const firstDialogue = await dialogueState();
check('narration starts the goal queue', firstDialogue?.speakerType === 'narrator', firstDialogue);
await page.screenshot({
  path: path.join(output, `goal-dialogue-${viewports.wide.label}.png`),
  fullPage: false,
});
await exerciseClickSemantics();
check('camp queue unlocks the destination decision', await drainDialogue());
check('camp destination choices appear after the queue', await page.locator('.shiguang-destination-choice').isVisible());
const destinationAdvanceBefore = await repeatedClick('[data-action="destination"][data-destination-id="echo_archive"]');
const travelVisible = await waitForPhase('travel', 4_000);
check('player destination change exposes a short travel phase', travelVisible);
if (travelVisible) {
  await page.waitForFunction(() => {
    const travel = document.querySelector('.shiguang-travel.is-active');
    return travel && Number.parseFloat(getComputedStyle(travel).opacity) > 0.9;
  });
  await page.screenshot({
    path: path.join(output, `travel-${viewports.wide.label}.png`),
    fullPage: false,
  });
}
check('destination choice does not advance the backend', advanceRequests.length === destinationAdvanceBefore, {
  requestDelta: advanceRequests.length - destinationAdvanceBefore,
});
check('arrival waits for its location dialogue', await waitForPhase('dialogue'));
check('arrival queue unlocks the real goal interaction', await drainDialogue());
check('goal continue action appears only after arrival', await page.locator('[data-action="continue"]').isVisible());
await stageSnapshot('goal-interactive', viewports.wide);

const goalAdvanceBefore = await repeatedClick('[data-action="continue"]');
await waitForState('scroll');
check('rapid goal clicks trigger one real advance request', advanceRequests.length - goalAdvanceBefore === 1, {
  requestDelta: advanceRequests.length - goalAdvanceBefore,
});
check('scroll response waits for its dialogue queue', await waitForPhase('dialogue'));
check('scroll interaction remains hidden during dialogue', await page.locator('[data-action="continue"]').count() === 0);
check('scroll response queue unlocks a new destination decision', await drainDialogue());
check('scroll offers a stay decision before interaction', await page.locator('[data-action="destination"][data-destination-kind="stay"]').isVisible());
await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
check('staying uses a local arrival dialogue', await waitForPhase('dialogue'));
check('staying unlocks the scroll interaction', await drainDialogue());
await stageSnapshot('scroll-interactive', viewports.wide);

await page.setViewportSize(viewports.standard);
const scrollAdvanceBefore = await repeatedClick('[data-action="continue"]');
await waitForState('method');
check('rapid scroll clicks trigger one real advance request', advanceRequests.length - scrollAdvanceBefore === 1, {
  requestDelta: advanceRequests.length - scrollAdvanceBefore,
});
check('method waits for its dialogue queue', await waitForPhase('dialogue'));
check('method choices are absent before dialogue completion', await page.locator('.shiguang-methods').count() === 0);
check('method response queue unlocks destination choice', await drainDialogue());
await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
check('method stay waits for location dialogue', await waitForPhase('dialogue'));
check('method stay unlocks interaction', await drainDialogue());
check('method choices appear after dialogue completion', await page.locator('.shiguang-methods').isVisible());
await stageSnapshot('method-interactive', viewports.standard);

await page.setViewportSize(viewports.compact);
const methodAdvanceBefore = await repeatedClick('[data-action="method"][data-method="practice"]');
await waitForState('trial');
check('rapid method clicks trigger one real advance request', advanceRequests.length - methodAdvanceBefore === 1, {
  requestDelta: advanceRequests.length - methodAdvanceBefore,
});
check('trial waits for its dialogue queue', await waitForPhase('dialogue'));
check('trial answers are absent before dialogue completion', await page.locator('.shiguang-options').count() === 0);
check('trial response reveals destination choice', await drainDialogue());
await page.locator('[data-action="destination"][data-destination-id="mirror_lake"]').click();
check('trial destination travel reaches arrival dialogue', await waitForPhase('dialogue'));
const trialTravelState = await page.locator('.shiguang-travel').evaluate((node) => ({
  active: node.classList.contains('is-active'),
  ariaHidden: node.getAttribute('aria-hidden'),
  opacity: Number.parseFloat(getComputedStyle(node).opacity),
}));
check(
  'travel layer is fully retired before dialogue',
  !trialTravelState.active && trialTravelState.ariaHidden === 'true' && trialTravelState.opacity < 0.05,
  trialTravelState,
);
await page.screenshot({
  path: path.join(output, `trial-dialogue-${viewports.compact.label}.png`),
  fullPage: false,
});
const trialEvents = await page.evaluate(() => window.__kakiDirectionEvents.filter((event) => event.state === 'TRIAL'));
const enteringRoles = trialEvents
  .filter((event) => event.type === 'character' && event.performance === 'entering')
  .map((event) => event.character);
check(
  'trial characters enter in player companion enemy order',
  enteringRoles.indexOf('player') >= 0
    && enteringRoles.indexOf('companion') > enteringRoles.indexOf('player')
    && enteringRoles.indexOf('enemy') > enteringRoles.indexOf('companion'),
  { enteringRoles },
);
check('trial arrival queue unlocks interaction', await drainDialogue());
const trialSpeakers = await page.evaluate(() => window.__kakiDirectionEvents
  .filter((event) => event.state === 'TRIAL' && event.type === 'dialogue' && event.event === 'line-start')
  .map((event) => event.speakerType));
check(
  'trial dialogue keeps narration and companion guidance',
  trialSpeakers.indexOf('narrator') >= 0
    && trialSpeakers.indexOf('companion') > trialSpeakers.indexOf('narrator'),
  { trialSpeakers },
);
check('trial answers appear after dialogue completion', await page.locator('.shiguang-options').isVisible());
await stageSnapshot('trial-interactive', viewports.compact);

const trialAdvanceBefore = await repeatedClick('.shiguang-options button:first-child');
await waitForState('supply');
check('rapid answer clicks submit once', advanceRequests.length - trialAdvanceBefore === 1, {
  requestDelta: advanceRequests.length - trialAdvanceBefore,
});
check('supply waits for its dialogue queue', await waitForPhase('dialogue'));
check('supply response unlocks destination choice', await drainDialogue());
await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
check('supply stay waits for dialogue', await waitForPhase('dialogue'));
check('supply stay unlocks interaction', await drainDialogue());
await page.locator('[data-action="continue"]').click();
await waitForState('interleave');
check('input stage waits for dialogue', await waitForPhase('dialogue'));
check('input is absent before dialogue completion', await page.locator('.shiguang-answer textarea').count() === 0);
check('interleave response unlocks destination choice', await drainDialogue());
await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
check('interleave stay waits for dialogue', await waitForPhase('dialogue'));
check('interleave stay unlocks input', await drainDialogue());
const answer = page.locator('.shiguang-answer textarea');
const inputFocused = await page.waitForFunction(() => {
  const node = document.querySelector('.shiguang-answer textarea');
  return Boolean(node && document.activeElement === node);
}, null, { timeout: 2_000 }).then(() => true).catch(() => false);
check('input appears after dialogue and receives focus', await answer.isVisible() && inputFocused);
await answer.fill('我会用正则化减少过拟合');
const interleaveAdvanceBefore = advanceRequests.length;
await page.locator('.shiguang-answer').evaluate((form) => {
  form.requestSubmit();
  form.requestSubmit();
  form.requestSubmit();
});
await waitForState('boss');
check('rapid input submissions call the backend once', advanceRequests.length - interleaveAdvanceBefore === 1, {
  requestDelta: advanceRequests.length - interleaveAdvanceBefore,
});
check('boss waits for its dialogue queue', await waitForPhase('dialogue'));
check('boss response unlocks destination choice', await drainDialogue());
await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
check('boss stay waits for dialogue', await waitForPhase('dialogue'));
check('boss stay unlocks interaction', await drainDialogue());

await page.addStyleTag({
  content: '.shiguang-scene, .shiguang-scene * { animation-duration: 30s !important; transition-duration: 30s !important; }',
});
await page.locator('.shiguang-answer textarea').fill('泛化能力是模型在未见新数据上的表现');
const bossLocalEventStart = await page.evaluate(() => window.__kakiDirectionEvents.length);
const bossAdvanceBefore = advanceRequests.length;
await page.locator('.shiguang-answer').evaluate((form) => {
  form.requestSubmit();
  form.requestSubmit();
});
await page.waitForFunction(() => document.querySelectorAll('.shiguang-boss-seals .lit').length === 1, null, {
  timeout: 10_000,
});
check('rapid boss submissions call the backend once', advanceRequests.length - bossAdvanceBefore === 1, {
  requestDelta: advanceRequests.length - bossAdvanceBefore,
});
check('same-scene boss progress uses a local transition', await page.locator('.shiguang-overlay').getAttribute('data-transition-kind') === 'local');
check('animation timeout protection reaches dialogue despite long CSS durations', await waitForPhase('dialogue', 6_000));
const bossLocalEvents = await page.evaluate(
  (start) => window.__kakiDirectionEvents.slice(start),
  bossLocalEventStart,
);
check(
  'local transition does not enter the travel phase',
  !bossLocalEvents.some((event) => event.type === 'phase' && event.phase === 'travel'),
  { phases: bossLocalEvents.filter((event) => event.type === 'phase').map((event) => event.phase) },
);
check('local boss queue unlocks destination choice', await drainDialogue());
await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
check('local boss stay reaches dialogue', await waitForPhase('dialogue', 6_000));
check('local boss stay unlocks interaction', await drainDialogue());

const secondBossChoice = page.locator('.shiguang-options button').first();
await secondBossChoice.click();
await page.waitForFunction(() => document.querySelectorAll('.shiguang-boss-seals .lit').length === 2);
await waitForPhase('dialogue', 6_000);
const eventsBeforeExit = await page.evaluate(() => window.__kakiDirectionEvents.length);
await page.locator('[data-action="leave"]').click();
check('mid-dialogue leave removes the game overlay', await page.locator('.shiguang-overlay').count() === 0);
check('closing the modal restores focus to its entry', await page.evaluate(() => document.activeElement?.id === 'adventureEntry'));
const eventsAtClosed = await page.evaluate(() => window.__kakiDirectionEvents.length);
await page.waitForTimeout(700);
const eventsAfterExit = await page.evaluate(() => window.__kakiDirectionEvents.length);
check('leaving cancels old dialogue timers', eventsAfterExit === eventsAtClosed, {
  before: eventsBeforeExit,
  atClosed: eventsAtClosed,
  after: eventsAfterExit,
});
check('leaving restores the chat draft', await page.locator('#input').inputValue() === '导演验收后仍需保留的草稿');
check('leaving preserves the current chat session', await page.locator('#messages .msg.assistant').count() > beforeAssistant);

await page.locator('#adventureEntry').click();
await waitForState('boss');
check('reopening restores directly without a full entrance', await waitForPhase('interactive', 3_000));
const reopenMetrics = await stageSnapshot('boss-restored', viewports.compact);
check('reopening marks the presentation as restore', reopenMetrics.transitionKind === 'restore', reopenMetrics);
check('reopening does not recreate a dialogue queue', await page.locator('.shiguang-dialogue').count() === 0);
await page.locator('[data-action="leave"]').click();

await page.reload({ waitUntil: 'networkidle' });
await page.locator('#adventureEntry').click();
await waitForState('boss');
check('refresh restores the current real stage', await waitForPhase('interactive', 3_000));
const refreshMetrics = await stageSnapshot('boss-refresh-restored', viewports.compact);
check('refresh recovery remains a lightweight restore', refreshMetrics.transitionKind === 'restore', refreshMetrics);
const refreshEvents = await page.evaluate(() => window.__kakiDirectionEvents);
check(
  'refresh recovery does not replay character entrance',
  !refreshEvents.some((event) => event.type === 'character' && event.performance === 'entering'),
  { refreshEvents },
);
await page.locator('[data-action="leave"]').click();

const directionEvents = await page.evaluate(() => window.__kakiDirectionEvents);
const failedChecks = checks.filter((item) => !item.passed);
const report = {
  status: failedChecks.length || consoleErrors.length || pageErrors.length || failedResponses.length ? 'FAIL' : 'PASS',
  frontendUrl: base,
  username,
  checks,
  failedChecks,
  advanceRequestCount: advanceRequests.length,
  directionEvents,
  consoleErrors,
  pageErrors,
  failedResponses,
  screenshots: [
    `goal-dialogue-${viewports.wide.label}.png`,
    `goal-interactive-${viewports.wide.label}.png`,
    `travel-${viewports.wide.label}.png`,
    `scroll-interactive-${viewports.wide.label}.png`,
    `method-interactive-${viewports.standard.label}.png`,
    `trial-dialogue-${viewports.compact.label}.png`,
    `trial-interactive-${viewports.compact.label}.png`,
    `boss-restored-${viewports.compact.label}.png`,
    `boss-refresh-restored-${viewports.compact.label}.png`,
  ].map((name) => path.join(output, name)),
};

await writeFile(path.join(output, 'game-scene-direction-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  status: report.status,
  checks: checks.length,
  failed: failedChecks.map((item) => item.name),
  advanceRequestCount: report.advanceRequestCount,
  consoleErrors,
  pageErrors,
  failedResponses,
}, null, 2));
await browser.close();
process.exitCode = report.status === 'PASS' ? 0 : 1;
