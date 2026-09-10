/* global document, getComputedStyle, localStorage, performance, process, window */

import { chromium } from '@playwright/test';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendUrl = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const frontendRoot = path.join(projectRoot, 'frontend');
const output = process.env.KAKI_SCENE_ART_EVIDENCE
  || path.join(projectRoot, 'evidence/game-scene-art-20260729');
const staticOnly = process.argv.includes('--static-only');
const desktopViewports = [
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1366, height: 768, label: '1366x768' },
];
const routes = [
  {
    id: 'echo_archive',
    name: '回声书阁',
    viewport: { width: 1920, height: 1080 },
    files: {
      base: 'echo_archive_base.webp',
      foreground: 'echo_archive_foreground.png',
      anomaly: 'echo_archive_anomaly.png',
      restored: 'echo_archive_restored.png',
    },
  },
  {
    id: 'mirror_lake',
    name: '镜湖',
    viewport: { width: 1440, height: 900 },
    files: {
      base: 'mirror_lake_base.webp',
      foreground: 'mirror_lake_foreground.png',
      anomaly: 'mirror_lake_anomaly.png',
      restored: 'mirror_lake_restored.png',
    },
  },
  {
    id: 'mechanism_workshop',
    name: '机关工坊',
    viewport: { width: 1366, height: 768 },
    files: {
      base: 'mechanism_workshop_base.webp',
      foreground: 'mechanism_workshop_foreground.png',
      anomaly: 'mechanism_workshop_anomaly.png',
      restored: 'mechanism_workshop_restored.png',
    },
  },
];
const checks = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const loadRecords = [];
const fallbackRecords = [];
const screenshots = [];

await mkdir(output, { recursive: true });

function check(name, condition, detail = {}) {
  checks.push({ name, passed: Boolean(condition), detail });
}

for (const route of routes) {
  for (const [kind, filename] of Object.entries(route.files)) {
    const absolute = path.join(
      frontendRoot,
      'public/ai-workspace/assets/adventure/scenes',
      filename,
    );
    let exists = true;
    try {
      await access(absolute);
      const info = await stat(absolute);
      check(`${route.id} ${kind} asset is non-empty`, info.size > 8_000, {
        path: absolute,
        bytes: info.size,
      });
    } catch {
      exists = false;
    }
    check(`${route.id} ${kind} formal asset exists`, exists, { path: absolute });
  }
}

const registrySource = await readFile(
  path.join(frontendRoot, 'public/ai-workspace/scripts/adventure-scene-registry.js'),
  'utf8',
);
const adventureSource = await readFile(
  path.join(frontendRoot, 'public/ai-workspace/scripts/ai-workspace-adventure.js'),
  'utf8',
);
check('registry declares formal scene art layers', routes.every((route) => (
  registrySource.includes(route.files.base)
  && registrySource.includes(route.files.foreground)
  && registrySource.includes(route.files.anomaly)
  && registrySource.includes(route.files.restored)
)));
check('camp destination choice preloads formal bases through the shared loader', (
  adventureSource.includes('preloadSceneBase')
  && adventureSource.includes('data-scene-base-preload')
));
check('scene rendering owns unified image layers', (
  adventureSource.includes('shiguang-scene-art-layer')
  && adventureSource.includes('foregroundAsset')
  && adventureSource.includes('anomalyAsset')
  && adventureSource.includes('restoredAsset')
));
check('asset fallback timeout uses real time independent of motion preferences', (
  adventureSource.includes('scheduleRealtime')
  && adventureSource.includes('scheduleRealtime(function () { if (!settled) fail(); }, 2500)')
));

if (staticOnly) {
  const failedChecks = checks.filter((item) => !item.passed);
  console.log(JSON.stringify({
    status: failedChecks.length ? 'FAIL' : 'PASS',
    checks: checks.length,
    failed: failedChecks.map((item) => item.name),
  }, null, 2));
  if (failedChecks.length) process.exitCode = 1;
} else {
  const browser = await chromium.launch({ headless: true });

  async function waitFor(page, predicate, argument, timeout = 10_000) {
    try {
      await page.waitForFunction(predicate, argument, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  async function drainDialogue(page) {
    let turns = 0;
    while (await page.locator('.shiguang-dialogue').count()) {
      turns += 1;
      if (turns > 28) throw new Error('dialogue queue did not finish');
      const state = await page.locator('.shiguang-dialogue').evaluate((node) => ({
        index: Number(node.dataset.queueIndex || 0),
        complete: node.dataset.lineComplete === 'true',
      }));
      await page.locator('[data-action="dialogue-next"]').click();
      await waitFor(
        page,
        ({ index, complete }) => {
          const node = document.querySelector('.shiguang-dialogue');
          if (!node) return true;
          return complete
            ? Number(node.dataset.queueIndex || 0) > index
            : Number(node.dataset.queueIndex || 0) === index && node.dataset.lineComplete === 'true';
        },
        state,
      );
    }
  }

  async function registerAndLogin(context, page, routeId) {
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const username = `scene_art_${routeId}_${stamp}`;
    const password = 'SceneArt!2026';
    const register = await context.request.post(`${frontendUrl}/api/auth/register`, {
      data: { username, password, email: `${username}@example.test` },
    });
    if (!register.ok()) throw new Error(`register returned ${register.status()}`);
    const account = (await register.json()).data;
    const headers = { Authorization: `Bearer ${account.token}` };
    const onboarding = await context.request.post(`${frontendUrl}/api/profile-onboarding/start`, { headers });
    const task = (await onboarding.json()).data;
    const skipped = await context.request.post(`${frontendUrl}/api/profile-onboarding/skip`, {
      headers,
      data: { task_id: task.task_id },
    });
    if (!skipped.ok()) throw new Error(`onboarding skip returned ${skipped.status()}`);

    await page.goto(`${frontendUrl}/login?redirect=/ai-learning`, { waitUntil: 'networkidle' });
    await page.getByTestId('auth-phone').fill(username);
    await page.getByTestId('auth-password').fill(password);
    const [loginResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/auth/login')),
      page.getByTestId('auth-submit').click(),
    ]);
    await page.waitForURL((url) => url.pathname === '/ai-learning', { timeout: 15_000 });
    check(`${routeId} uses the rendered real login flow`, loginResponse.status() === 200, {
      status: loginResponse.status(),
    });
    return { headers, username };
  }

  async function startAndChoose(page, route) {
    await page.locator('#adventureEntry').click();
    await page.locator('#shiguangTopic').fill('机器学习模型评估');
    await page.locator('input[name="source"][value="manual"]').check();
    await page.locator('.shiguang-schools label[data-school="wood"]').click();
    await page.locator('[data-action="confirm-school"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
    await page.locator('[data-action="start"]').click();
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.dataset.directionPhase === 'dialogue',
      null,
    );
    await drainDialogue(page);
    check(`${route.id} camp shows a real destination choice`, await page.locator(
      `[data-action="destination"][data-destination-id="${route.id}"]`,
    ).isVisible());
    const preloadMetrics = await page.evaluate(() => ({
      hrefs: [...document.querySelectorAll('link[data-scene-base-preload]')].map((node) => node.href),
      count: document.querySelectorAll('link[data-scene-base-preload]').length,
    }));
    check(`${route.id} camp preloads exactly the three launch bases`, preloadMetrics.count === 3, preloadMetrics);
    await page.locator(`[data-action="destination"][data-destination-id="${route.id}"]`).click();
    await waitFor(
      page,
      (id) => document.querySelector('.shiguang-overlay')?.dataset.sceneId === id,
      route.id,
    );
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.dataset.directionPhase === 'dialogue',
      null,
    );
    await drainDialogue(page);
  }

  async function sceneMetrics(page) {
    return page.evaluate(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      const scene = document.querySelector('.shiguang-scene');
      const layers = [...document.querySelectorAll('.shiguang-scene-art-layer')].map((node) => ({
        kind: node.dataset.layerKind,
        active: node.dataset.layerActive === 'true',
        src: node.getAttribute('src'),
        hidden: node.hidden,
        loaded: node.complete && node.naturalWidth > 0,
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
        opacity: Number.parseFloat(getComputedStyle(node).opacity),
      }));
      const characters = [...document.querySelectorAll(
        '.shiguang-player, .shiguang-mascot, .shiguang-enemy',
      )].map((node) => ({
        className: node.className,
        src: node.getAttribute('src'),
      }));
      const resourceTimings = performance.getEntriesByType('resource')
        .filter((entry) => /(echo_archive|mirror_lake|mechanism_workshop)_(base|foreground|anomaly|restored)\.(webp|png)/.test(entry.name))
        .map((entry) => ({
          name: entry.name,
          durationMs: Number(entry.duration.toFixed(2)),
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize,
        }));
      return {
        sceneId: overlay?.dataset.sceneId || '',
        backendState: overlay?.dataset.state || '',
        appearance: scene?.dataset.sceneState || '',
        fallback: scene?.dataset.sceneFallback || '',
        layers,
        characters,
        resourceTimings,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        routeRecord: Object.keys(localStorage)
          .filter((key) => key.startsWith('kaki_adventure_route_v1:'))
          .map((key) => JSON.parse(localStorage.getItem(key)))
          .find((item) => item.currentSceneId === overlay?.dataset.sceneId),
      };
    });
  }

  async function capture(page, route, phase) {
    await page.setViewportSize(route.viewport);
    await page.waitForTimeout(450);
    const filename = `${route.id}-${phase}-${route.viewport.width}x${route.viewport.height}.png`;
    const absolute = path.join(output, filename);
    await page.screenshot({ path: absolute, fullPage: false });
    screenshots.push(absolute);
    const metrics = await sceneMetrics(page);
    loadRecords.push({ routeId: route.id, phase, metrics });
    return metrics;
  }

  async function advance(context, headers, runId, action, payload = {}) {
    const response = await context.request.post(`${frontendUrl}/api/adventure/advance`, {
      headers,
      data: { run_id: runId, action, payload },
    });
    if (!response.ok()) throw new Error(`advance ${action} returned ${response.status()}: ${await response.text()}`);
    return (await response.json()).data;
  }

  async function reopen(page, expectedState) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#adventureEntry').click();
    check(
      `refresh restores real backend ${expectedState} state`,
      await waitFor(
        page,
        (state) => document.querySelector('.shiguang-overlay')?.dataset.state === state,
        expectedState.toLowerCase(),
      ),
    );
    await waitFor(
      page,
      () => document.querySelector('.shiguang-overlay')?.dataset.directionPhase === 'interactive',
      null,
    );
  }

  async function reachReview(context, headers, runId) {
    await advance(context, headers, runId, 'continue');
    await advance(context, headers, runId, 'choose_strategy', { choice: 'understanding' });
    return advance(context, headers, runId, 'submit', { answer: '只要训练分数高就行' });
  }

  async function reachTreasury(context, headers, runId, game) {
    game = await advance(context, headers, runId, 'submit', {
      answer: game.content.understanding.interleave.options[0],
    });
    game = await advance(context, headers, runId, 'submit', {
      answer: '泛化能力是模型在未见新数据上的预测表现',
    });
    game = await advance(context, headers, runId, 'submit', {
      answer: game.content.boss[1].options[0],
    });
    return advance(context, headers, runId, 'submit', {
      answer: '这是过拟合，我会使用早停来改善泛化',
    });
  }

  for (const route of routes) {
    const context = await browser.newContext({ viewport: route.viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push({ routeId: route.id, text: message.text() });
    });
    page.on('pageerror', (error) => pageErrors.push({ routeId: route.id, message: error.message }));
    page.on('response', (response) => {
      if (response.status() >= 500) failedResponses.push({
        routeId: route.id,
        status: response.status(),
        url: response.url(),
      });
    });
    await page.addInitScript(() => {
      window.__kakiSceneArtEvents = [];
      window.__kakiDirectionEvents = [];
      document.addEventListener('shiguang:direction', (event) => {
        window.__kakiDirectionEvents.push({ ...event.detail, at: performance.now() });
        if (event.detail?.type === 'asset-fallback') {
          window.__kakiSceneArtEvents.push({ ...event.detail, at: performance.now() });
        }
      });
    });

    try {
      const { headers } = await registerAndLogin(context, page, route.id);
      await startAndChoose(page, route);
      const normal = await capture(page, route, 'normal');
      check(`${route.id} uses its formal base and common foreground`, (
        normal.sceneId === route.id
        && normal.fallback === 'false'
        && normal.layers.some((layer) => layer.kind === 'foreground' && layer.active && layer.loaded)
      ), normal);
      check(`${route.id} normal state excludes anomaly and restored art`, (
        !normal.layers.some((layer) => ['anomaly', 'restored'].includes(layer.kind) && layer.active)
      ), normal.layers);
      check(`${route.id} does not replace character assets with scene art`, (
        normal.characters.every((character) => !Object.values(route.files).some(
          (filename) => character.src?.includes(filename),
        ))
      ), normal.characters);
      check(`${route.id} has no horizontal overflow`, !normal.overflow, normal);
      for (const viewport of desktopViewports) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(180);
        const viewportMetrics = await sceneMetrics(page);
        check(`${route.id} remains full-screen and overflow-free at ${viewport.label}`, (
          viewportMetrics.sceneId === route.id
          && !viewportMetrics.overflow
          && viewportMetrics.layers.some(
            (layer) => layer.kind === 'foreground' && layer.active && layer.loaded,
          )
        ), viewportMetrics);
        const viewportShot = path.join(output, `viewport-audit-${route.id}-${viewport.label}.png`);
        await page.screenshot({ path: viewportShot, fullPage: false });
        screenshots.push(viewportShot);
      }
      await page.setViewportSize(route.viewport);

      const runId = normal.routeRecord?.runId;
      check(`${route.id} route record keeps the real backend run id`, Boolean(runId), normal.routeRecord || {});
      const persistentRoleTokens = await page.evaluate(() => {
        const player = document.querySelector('.shiguang-scene .shiguang-player');
        const mascot = document.querySelector('.shiguang-scene .shiguang-mascot');
        player.dataset.sceneArtIdentity = `player-${Date.now()}`;
        mascot.dataset.sceneArtIdentity = `mascot-${Date.now()}`;
        return {
          player: player.dataset.sceneArtIdentity,
          mascot: mascot.dataset.sceneArtIdentity,
        };
      });
      await page.locator('[data-action="continue"]').click();
      await waitFor(
        page,
        () => document.querySelector('.shiguang-overlay')?.dataset.directionPhase === 'dialogue',
        null,
      );
      const persistentRoles = await page.evaluate(() => ({
        player: document.querySelector('.shiguang-scene .shiguang-player')?.dataset.sceneArtIdentity || '',
        mascot: document.querySelector('.shiguang-scene .shiguang-mascot')?.dataset.sceneArtIdentity || '',
        transitionKind: document.querySelector('.shiguang-overlay')?.dataset.transitionKind || '',
      }));
      check(`${route.id} local backend state change preserves persistent character nodes`, (
        persistentRoles.transitionKind === 'local'
        && persistentRoles.player === persistentRoleTokens.player
        && persistentRoles.mascot === persistentRoleTokens.mascot
      ), { before: persistentRoleTokens, after: persistentRoles });
      let game = await reachReview(context, headers, runId);
      check(`${route.id} reaches review through real backend advances`, (
        game.state === 'SUPPLY' && game.feedback?.kind === 'needs_review'
      ), { state: game.state, feedback: game.feedback });
      await reopen(page, 'supply');
      const anomaly = await capture(page, route, 'anomaly');
      check(`${route.id} review state activates only anomaly art`, (
        anomaly.appearance === 'anomaly'
        && anomaly.layers.some((layer) => layer.kind === 'anomaly' && layer.active && layer.loaded)
        && !anomaly.layers.some((layer) => layer.kind === 'restored' && layer.active)
      ), anomaly.layers);

      game = await advance(context, headers, runId, 'submit', {
        answer: game.content.remedy.options[0],
      });
      await reopen(page, 'interleave');
      const restored = await capture(page, route, 'restored');
      check(`${route.id} successful remedy activates only restored art`, (
        restored.appearance === 'restored'
        && restored.layers.some((layer) => layer.kind === 'restored' && layer.active && layer.loaded)
        && !restored.layers.some((layer) => layer.kind === 'anomaly' && layer.active)
      ), restored.layers);
      const fallbackStart = await page.evaluate(() => window.__kakiSceneArtEvents.length);
      await page.locator('.shiguang-scene-art-layer[data-layer-kind="restored"]').evaluate((node) => {
        node.src = `/ai-workspace/assets/adventure/scenes/__missing_scene_art_${Date.now()}.png`;
      });
      await waitFor(
        page,
        (start) => window.__kakiSceneArtEvents.length > start,
        fallbackStart,
        4_000,
      );
      const fallback = await page.evaluate(
        (start) => window.__kakiSceneArtEvents.slice(start),
        fallbackStart,
      );
      fallbackRecords.push({ routeId: route.id, fallback });
      check(`${route.id} failed overlay hides safely and emits a fallback record`, (
        fallback.length >= 1
        && await page.locator('.shiguang-dialogue').count() === 0
        && await page.locator('.shiguang-overlay').isVisible()
      ), { fallback });

      game = await reachTreasury(context, headers, runId, game);
      check(`${route.id} reaches treasury only after real successful interactions`, game.state === 'TREASURY', {
        state: game.state,
        bossStage: game.archive?.boss_stage,
      });
      await reopen(page, 'treasury');
      await waitFor(
        page,
        () => {
          const foreground = document.querySelector('.shiguang-scene-art-layer[data-layer-kind="foreground"]');
          return Boolean(foreground && foreground.complete && foreground.naturalWidth > 0);
        },
        null,
        8_000,
      );
      const treasury = await sceneMetrics(page);
      check(`${route.id} hands off to the formal shared treasury scene`, (
        treasury.sceneId === 'harvest_treasury'
        && treasury.fallback === 'false'
        && treasury.layers.some((layer) => (
          layer.kind === 'foreground' && layer.active && layer.naturalWidth > 0
        ))
      ), treasury);
      const refreshEvents = await page.evaluate(() => window.__kakiDirectionEvents);
      check(`${route.id} refresh restore does not replay character entrance`, (
        !refreshEvents.some((event) => event.type === 'character' && event.performance === 'entering')
      ), { refreshEvents });
    } catch (error) {
      check(`${route.id} real scene-art journey completes`, false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await context.close();
  }

  const failedChecks = checks.filter((item) => !item.passed);
  const report = {
    status: failedChecks.length || consoleErrors.length || pageErrors.length || failedResponses.length
      ? 'FAIL'
      : 'PASS',
    frontendUrl,
    checks,
    failedChecks,
    consoleErrors,
    pageErrors,
    failedResponses,
    loadRecords,
    fallbackRecords,
    screenshots,
  };
  await writeFile(
    path.join(output, 'game-scene-art-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(output, 'scene-art-load-fallback-records.json'),
    `${JSON.stringify({ loadRecords, fallbackRecords }, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({
    status: report.status,
    checks: checks.length,
    failed: failedChecks.map((item) => item.name),
    screenshots: screenshots.length,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
    failedResponses: failedResponses.length,
  }, null, 2));
  await browser.close();
  if (report.status !== 'PASS') process.exitCode = 1;
}
