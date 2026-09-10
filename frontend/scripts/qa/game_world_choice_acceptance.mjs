/* global console, document, getComputedStyle, localStorage, performance, process, window */

import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.env.KAKI_WORLD_CHOICE_EVIDENCE
  || path.join(projectRoot, 'evidence/game-world-choice-20260729');
const viewports = {
  echo_archive: { width: 1920, height: 1080, label: '1920x1080' },
  mirror_lake: { width: 1440, height: 900, label: '1440x900' },
  mechanism_workshop: { width: 1366, height: 768, label: '1366x768' },
};
const expectedNames = {
  echo_archive: '回声书阁',
  mirror_lake: '镜湖',
  mechanism_workshop: '机关工坊',
};
const checks = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const routeRuns = [];
const screenshots = [];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });

function check(name, condition, detail = {}) {
  checks.push({ name, passed: Boolean(condition), detail });
}

async function waitFor(page, predicate, argument, timeout = 6_000) {
  try {
    await page.waitForFunction(predicate, argument, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function registerAndLogin(context, page, routeId) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const username = `world_choice_${routeId}_${stamp}`;
  const password = 'WorldChoice!2026';
  const register = await context.request.post(`${base}/api/auth/register`, {
    data: { username, password, email: `${username}@example.test` },
  });
  if (!register.ok()) throw new Error(`register returned ${register.status()}: ${await register.text()}`);
  const registered = (await register.json()).data;
  const headers = { Authorization: `Bearer ${registered.token}` };
  const onboardingStart = await context.request.post(`${base}/api/profile-onboarding/start`, { headers });
  if (!onboardingStart.ok()) throw new Error(`onboarding start returned ${onboardingStart.status()}`);
  const task = (await onboardingStart.json()).data;
  const onboardingSkip = await context.request.post(`${base}/api/profile-onboarding/skip`, {
    headers,
    data: { task_id: task.task_id },
  });
  if (!onboardingSkip.ok()) throw new Error(`onboarding skip returned ${onboardingSkip.status()}`);

  await page.goto(`${base}/login?redirect=/ai-learning`, { waitUntil: 'networkidle' });
  await page.getByTestId('auth-phone').fill(username);
  await page.getByTestId('auth-password').fill(password);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/auth/login')),
    page.getByTestId('auth-submit').click(),
  ]);
  await page.waitForURL((url) => url.pathname === '/ai-learning', { timeout: 15_000 });
  await page.locator('#adventureEntry').waitFor({ state: 'visible' });
  check(`${routeId} authenticates through the rendered login form`, loginResponse.status() === 200, {
    status: loginResponse.status(),
  });
  return { username, registered };
}

async function exerciseRealChat(page) {
  const before = await page.locator('#messages .msg.assistant').count();
  await page.locator('#input').fill('用一句话说明训练集与测试集的区别。');
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.url().includes('/api/chat/stream'), { timeout: 60_000 }),
    page.locator('#send').click(),
  ]);
  await page.waitForFunction(
    (count) => document.querySelectorAll('#messages .msg.assistant').length > count
      && !document.querySelector('#send')?.disabled,
    before,
    { timeout: 120_000 },
  );
  check('ordinary chat still uses the real stream endpoint', response.status() === 200, {
    status: response.status(),
  });
}

async function dialogueState(page) {
  return page.evaluate(() => {
    const dialogue = document.querySelector('.shiguang-dialogue');
    if (!dialogue) return null;
    return {
      index: Number(dialogue.getAttribute('data-queue-index') || 0),
      complete: dialogue.getAttribute('data-line-complete') === 'true',
    };
  });
}

async function drainDialogue(page) {
  let turns = 0;
  while (await page.locator('.shiguang-dialogue').count()) {
    turns += 1;
    if (turns > 24) throw new Error('dialogue queue did not finish');
    const current = await dialogueState(page);
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
          return !dialogue || (Number(dialogue.getAttribute('data-queue-index')) === index
            && dialogue.getAttribute('data-line-complete') === 'true');
        },
        current?.index || 0,
      );
    }
  }
}

async function waitForState(page, expected, timeout = 12_000) {
  return waitFor(
    page,
    (state) => document.querySelector('.shiguang-overlay')?.getAttribute('data-state') === state,
    expected,
    timeout,
  );
}

async function waitForScene(page, sceneId, timeout = 8_000) {
  return waitFor(
    page,
    (id) => document.querySelector('.shiguang-overlay')?.getAttribute('data-scene-id') === id,
    sceneId,
    timeout,
  );
}

async function waitForDestinationChoice(page, timeout = 5_000) {
  return waitFor(
    page,
    () => Boolean(document.querySelector('.shiguang-destination-choice')),
    null,
    timeout,
  );
}

async function startJourney(page, routeId) {
  await page.locator('#input').fill(`路线 ${expectedNames[routeId]} 验收后仍需保留的草稿`);
  await page.locator('#adventureEntry').click();
  await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
  await page.locator('#shiguangTopic').fill('机器学习模型评估');
  await page.locator('input[name="source"][value="manual"]').check();
  await page.locator('.shiguang-schools label[data-school="wood"]').click();
  await page.locator('[data-action="confirm-school"]').click();
  await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
  await page.locator('[data-action="start"]').click();
  check(`${routeId} real game starts at GOAL backend state`, await waitForState(page, 'goal'));
  await waitFor(
    page,
    () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
    null,
    8_000,
  );
  await drainDialogue(page);
}

async function registryMetrics(page) {
  return page.evaluate(() => {
    const registry = window.KakiAdventureSceneRegistry;
    if (!registry || typeof registry.list !== 'function') return { available: false, scenes: [] };
    const scenes = registry.list();
    const requiredFields = [
      'id', 'name', 'shortDescription', 'region', 'learningAffordances', 'background',
      'fallbackBackground', 'foreground', 'atmosphere', 'playerAnchor', 'companionAnchor',
      'enemyAnchor', 'entryDirection', 'exitDirection', 'availableStates', 'transitionStyle',
      'musicKey', 'ambientKey', 'interactiveObjects',
    ];
    return {
      available: true,
      scenes,
      complete: scenes.every((scene) => requiredFields.every((field) => Object.hasOwn(scene, field))),
    };
  });
}

async function sceneMetrics(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('.shiguang-overlay');
    const scene = document.querySelector('.shiguang-scene');
    const caption = document.querySelector('.shiguang-scene-caption span');
    const destinations = [...document.querySelectorAll('[data-action="destination"]')].map((button) => ({
      id: button.getAttribute('data-destination-id'),
      kind: button.getAttribute('data-destination-kind'),
      text: button.textContent.trim(),
    }));
    const routeKeys = Object.keys(localStorage).filter((key) => key.startsWith('kaki_adventure_route_v1:'));
    const routeRecords = routeKeys.map((key) => {
      try { return { key, value: JSON.parse(localStorage.getItem(key)) }; } catch { return { key, value: null }; }
    });
    return {
      sceneId: overlay?.getAttribute('data-scene-id') || '',
      sceneState: scene?.getAttribute('data-scene-state') || '',
      fallback: scene?.getAttribute('data-scene-fallback') || '',
      background: scene ? getComputedStyle(scene).getPropertyValue('--scene') : '',
      caption: caption?.textContent || '',
      prelude: document.querySelector('.shiguang-scene-prelude')?.textContent.trim() || '',
      destinations,
      routeRecords,
      state: overlay?.getAttribute('data-state') || '',
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      playerCount: document.querySelectorAll('.shiguang-scene .shiguang-player').length,
      companionCount: document.querySelectorAll('.shiguang-scene .shiguang-mascot').length,
    };
  });
}

async function chooseDestination(page, destinationId, advanceRequests) {
  const selector = `[data-action="destination"][data-destination-id="${destinationId}"]`;
  const beforeAdvance = advanceRequests.length;
  const beforeWorldEvents = await page.evaluate(() => window.__kakiWorldEvents.length);
  await page.locator(selector).evaluate((button) => {
    button.click();
    button.click();
    button.click();
  });
  const arrived = await waitForScene(page, destinationId);
  const choiceEvents = await page.evaluate(
    (start) => window.__kakiWorldEvents.slice(start).filter((event) => event.type === 'destination-chosen'),
    beforeWorldEvents,
  );
  check(`${destinationId} rapid selection changes the route once`, choiceEvents.length === 1, {
    choiceEvents,
  });
  check(`${destinationId} presentation choice does not call backend advance`, advanceRequests.length === beforeAdvance, {
    requestDelta: advanceRequests.length - beforeAdvance,
  });
  return arrived;
}

async function runRoute(routeId, extended) {
  const viewport = viewports[routeId];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const advanceRequests = [];
  const worldEvents = [];
  const directionEvents = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push({ routeId, text: message.text() });
  });
  page.on('pageerror', (error) => pageErrors.push({ routeId, message: error.message }));
  page.on('response', (response) => {
    if (response.status() >= 500) failedResponses.push({ routeId, status: response.status(), url: response.url() });
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/adventure/advance')) {
      advanceRequests.push({ url: request.url(), at: Date.now() });
    }
  });
  await page.addInitScript(() => {
    window.__kakiWorldEvents = [];
    window.__kakiDirectionEvents = [];
    document.addEventListener('shiguang:world', (event) => {
      window.__kakiWorldEvents.push({ ...event.detail, at: performance.now() });
    });
    document.addEventListener('shiguang:direction', (event) => {
      window.__kakiDirectionEvents.push({ ...event.detail, at: performance.now() });
    });
  });

  await registerAndLogin(context, page, routeId);
  if (extended) await exerciseRealChat(page);
  await startJourney(page, routeId);

  const registry = await registryMetrics(page);
  check('scene registry is loaded before the adventure module', registry.available, registry);
  check('scene registry exposes all required scene capabilities', registry.complete, {
    sceneCount: registry.scenes.length,
  });
  check('scene registry includes the six required locations', [
    'camp', 'echo_archive', 'mirror_lake', 'mechanism_workshop', 'mist_valley', 'transfer_bridge',
  ].every((id) => registry.scenes.some((scene) => scene.id === id)), {
    ids: registry.scenes.map((scene) => scene.id),
  });
  const launchScenes = registry.scenes.filter((scene) => [
    'echo_archive', 'mirror_lake', 'mechanism_workshop',
  ].includes(scene.id));
  check('the three launch routes use distinct registered entry directions', new Set(
    launchScenes.map((scene) => scene.entryDirection),
  ).size === 3, launchScenes.map((scene) => ({
    id: scene.id,
    entryDirection: scene.entryDirection,
    exitDirection: scene.exitDirection,
  })));
  check('the three launch routes have distinct opening and interaction guidance', new Set(
    launchScenes.map((scene) => scene.arrivalNarration),
  ).size === 3 && new Set(
    launchScenes.map((scene) => scene.interactionPrelude),
  ).size === 3, launchScenes.map((scene) => ({
    id: scene.id,
    arrivalNarration: scene.arrivalNarration,
    interactionPrelude: scene.interactionPrelude,
  })));

  const initialChoiceReady = await waitForDestinationChoice(page);
  check(`${routeId} arrives at camp before choosing a destination`, await waitForScene(page, 'camp'), await sceneMetrics(page));
  check(`${routeId} camp dialogue reveals destination choices`, initialChoiceReady);
  if (!initialChoiceReady) {
    routeRuns.push({ routeId, status: 'blocked-before-choice', advanceRequests: advanceRequests.length });
    await context.close();
    return;
  }

  const initialMetrics = await sceneMetrics(page);
  check(`${routeId} camp offers only two to four contextual destinations`, initialMetrics.destinations.length >= 2 && initialMetrics.destinations.length <= 4, initialMetrics);
  check(`${routeId} backend does not auto-advance while waiting for player choice`, advanceRequests.length === 0, {
    advanceRequests: advanceRequests.length,
  });
  await page.waitForTimeout(700);
  check(`${routeId} remains at GOAL until the player decides`, (await sceneMetrics(page)).state === 'goal');

  check(`${routeId} selected scene becomes active`, await chooseDestination(page, routeId, advanceRequests));
  await waitFor(
    page,
    () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
    null,
    8_000,
  );
  const arrivalEvents = await page.evaluate(() => ({
    world: window.__kakiWorldEvents,
    direction: window.__kakiDirectionEvents,
  }));
  worldEvents.push(...arrivalEvents.world);
  directionEvents.push(...arrivalEvents.direction);
  await drainDialogue(page);
  const arrivedMetrics = await sceneMetrics(page);
  check(`${routeId} scene caption is location-specific`, arrivedMetrics.caption === expectedNames[routeId], arrivedMetrics);
  check(`${routeId} changes the visible registered background`, arrivedMetrics.background && arrivedMetrics.background !== initialMetrics.background, arrivedMetrics);
  check(`${routeId} records formal scene status honestly`, arrivedMetrics.fallback === 'false', arrivedMetrics);
  check(`${routeId} shows location-specific interaction preparation`, arrivedMetrics.prelude.includes(expectedNames[routeId]), arrivedMetrics);
  check(`${routeId} reveals the real GOAL interaction after arrival dialogue`, await page.locator('[data-action="continue"]').isVisible());
  check(`${routeId} has one player and one companion`, arrivedMetrics.playerCount === 1 && arrivedMetrics.companionCount === 1, arrivedMetrics);
  check(`${routeId} has no horizontal overflow at ${viewport.label}`, !arrivedMetrics.horizontalOverflow, arrivedMetrics);

  const screenshotName = `${routeId}-${viewport.label}.png`;
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(output, screenshotName), fullPage: false });
  screenshots.push(path.join(output, screenshotName));

  if (extended) {
    const beforeGoalAdvance = advanceRequests.length;
    const goalResponse = page.waitForResponse((response) => response.url().includes('/api/adventure/advance'));
    await page.locator('[data-action="continue"]').evaluate((button) => {
      button.click();
      button.click();
      button.click();
    });
    await page.keyboard.press('Escape');
    check('closing during a real advance immediately restores the workspace', await page.locator('.shiguang-overlay').count() === 0);
    await goalResponse;
    check('rapid real interaction calls backend advance once', advanceRequests.length - beforeGoalAdvance === 1, {
      requestDelta: advanceRequests.length - beforeGoalAdvance,
    });
    await page.locator('#adventureEntry').click();
    check('real GOAL interaction advances the backend to SCROLL', await waitForState(page, 'scroll'));
    check('reopening after an in-flight advance restores its destination decision', await waitForDestinationChoice(page));
    const onward = await sceneMetrics(page);
    check('onward choice offers at least two destinations', onward.destinations.filter((item) => item.kind === 'travel').length >= 2, onward);
    check('onward choice allows staying in the current location', onward.destinations.some((item) => item.kind === 'stay'), onward);
    check('onward choice allows returning to camp', onward.destinations.some((item) => item.kind === 'camp'), onward);
    check('the reachable route graph exposes mist valley', onward.destinations.some((item) => item.id === 'mist_valley'), onward);

    await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      5_000,
    );
    await drainDialogue(page);
    check('staying keeps the same scene and reveals SCROLL interaction', await waitForScene(page, routeId)
      && await page.locator('[data-action="continue"]').isVisible());

    await page.locator('[data-action="continue"]').click();
    check('second real interaction advances backend to METHOD', await waitForState(page, 'method'));
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      8_000,
    );
    await drainDialogue(page);
    check('METHOD waits for another player destination decision', await waitForDestinationChoice(page));
    await page.locator('[data-action="destination"][data-destination-id="mist_valley"]').click();
    check('mist valley is a real reachable scene', await waitForScene(page, 'mist_valley'));
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      8_000,
    );
    await drainDialogue(page);
    check('mist valley reveals the real METHOD interaction', await page.locator('[data-action="method"][data-method="practice"]').isVisible());
    await page.locator('[data-action="method"][data-method="practice"]').click();
    check('real method selection advances backend to TRIAL', await waitForState(page, 'trial'));
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      8_000,
    );
    await drainDialogue(page);
    const mistOnward = await sceneMetrics(page);
    check('the reachable route graph exposes transfer bridge', mistOnward.destinations.some((item) => item.id === 'transfer_bridge'), mistOnward);
    await page.locator('[data-action="destination"][data-destination-id="transfer_bridge"]').click();
    check('transfer bridge is a real reachable scene', await waitForScene(page, 'transfer_bridge'));
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      8_000,
    );
    await drainDialogue(page);
    check('transfer bridge reveals the real TRIAL question', await page.locator('.shiguang-options button').first().isVisible());
    await page.locator('.shiguang-options button').first().click();
    check('a real question submission advances backend to SUPPLY', await waitForState(page, 'supply'));
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      8_000,
    );
    await drainDialogue(page);
    await page.locator('[data-action="destination"][data-destination-kind="camp"]').click();
    check('player can return to camp without resetting backend progress', await waitForScene(page, 'camp')
      && (await sceneMetrics(page)).state === 'supply');
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      8_000,
    );
    await drainDialogue(page);
    check('camp becomes a decision center again', await waitForDestinationChoice(page));
    await page.locator('[data-action="destination"][data-destination-id="mechanism_workshop"]').click();
    check('camp can launch a second selected destination', await waitForScene(page, 'mechanism_workshop'));
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.getAttribute('data-direction-phase') === 'dialogue',
      null,
      8_000,
    );
    await drainDialogue(page);

    const beforeLeave = await sceneMetrics(page);
    const routeRecord = beforeLeave.routeRecords.find((record) => record.value?.runId);
    check('route persistence records current, visited, last chosen, and history', Boolean(
      routeRecord
      && routeRecord.value.currentSceneId === 'mechanism_workshop'
      && routeRecord.value.visitedSceneIds.includes('camp')
      && routeRecord.value.visitedSceneIds.includes('echo_archive')
      && routeRecord.value.visitedSceneIds.includes('mist_valley')
      && routeRecord.value.visitedSceneIds.includes('transfer_bridge')
      && routeRecord.value.visitedSceneIds.includes('mechanism_workshop')
      && routeRecord.value.lastChosenDestinationId === 'mechanism_workshop'
      && routeRecord.value.sceneChoiceHistory.length >= 6
    ), routeRecord || {});

    await page.locator('[data-action="leave"]').click();
    check('leaving restores the AI workspace draft', await page.locator('#input').inputValue() === `路线 ${expectedNames[routeId]} 验收后仍需保留的草稿`);
    await page.locator('#adventureEntry').click();
    check('reopening restores the selected scene', await waitForScene(page, 'mechanism_workshop'));
    await page.locator('[data-action="leave"]').click();
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#adventureEntry').waitFor({ state: 'visible' });
    await page.locator('#adventureEntry').click();
    check('refresh restores selected scene and visited route', await waitForScene(page, 'mechanism_workshop'));
    const restored = await sceneMetrics(page);
    check('refresh restoration keeps backend SUPPLY state', restored.state === 'supply', restored);
    await page.locator('[data-action="leave"]').click();

    const auth = await page.evaluate(() => ({ token: localStorage.getItem('token') }));
    const newRun = await context.request.post(`${base}/api/adventure/start`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      data: {
        topic: '支持向量机间隔',
        magic_school: 'wind',
        source_ids: [],
        source_type: 'manual',
        force_new: true,
      },
    });
    check('new journey is created by the real backend', newRun.ok(), { status: newRun.status() });
    const newRunPayload = newRun.ok() ? await newRun.json() : null;
    const newRunId = newRunPayload?.data?.run_id || '';
    await page.locator('#adventureEntry').click();
    check('new journey starts from a clean camp route', await waitForScene(page, 'camp'));
    const newRoute = await sceneMetrics(page);
    const newRecord = newRoute.routeRecords.find((record) => record.value?.runId === newRunId);
    check('new journey does not inherit the old visited route', Boolean(
      newRecord
      && newRecord.value.currentSceneId === 'camp'
      && newRecord.value.visitedSceneIds.length === 1
      && newRecord.value.visitedSceneIds[0] === 'camp'
    ), newRecord || {});
    await page.locator('[data-action="leave"]').click();
  } else {
    await page.locator('[data-action="leave"]').click();
  }

  routeRuns.push({
    routeId,
    status: 'completed',
    advanceRequests: advanceRequests.length,
    worldEvents,
    directionEvents,
  });
  await context.close();
}

for (const routeId of ['echo_archive', 'mirror_lake', 'mechanism_workshop']) {
  try {
    await runRoute(routeId, routeId === 'echo_archive');
  } catch (error) {
    check(`${routeId} route completes without an unhandled QA exception`, false, {
      message: error instanceof Error ? error.message : String(error),
    });
    routeRuns.push({ routeId, status: 'exception', message: error instanceof Error ? error.message : String(error) });
  }
}

const failedChecks = checks.filter((item) => !item.passed);
const report = {
  status: failedChecks.length || consoleErrors.length || pageErrors.length || failedResponses.length ? 'FAIL' : 'PASS',
  frontendUrl: base,
  checks,
  failedChecks,
  routeRuns,
  consoleErrors,
  pageErrors,
  failedResponses,
  screenshots,
};

await writeFile(path.join(output, 'game-world-choice-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  status: report.status,
  checks: checks.length,
  failed: failedChecks.map((item) => item.name),
  routeRuns: routeRuns.map((item) => ({ routeId: item.routeId, status: item.status })),
  consoleErrors: consoleErrors.length,
  pageErrors: pageErrors.length,
  failedResponses: failedResponses.length,
}, null, 2));
await browser.close();
if (report.status !== 'PASS') process.exitCode = 1;
