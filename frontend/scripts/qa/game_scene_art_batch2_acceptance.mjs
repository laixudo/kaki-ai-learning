/* global document, getComputedStyle, localStorage, performance, window */

import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const frontendRoot = path.join(projectRoot, 'frontend');
const frontendUrl = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const output = process.env.KAKI_SCENE_ART_BATCH2_EVIDENCE
  || path.join(projectRoot, 'evidence', 'game-scene-art-batch2-20260729');
const staticOnly = process.argv.includes('--static-only');
const sceneRoot = path.join(frontendRoot, 'public', 'ai-workspace', 'assets', 'adventure', 'scenes');
const registryPath = path.join(frontendRoot, 'public', 'ai-workspace', 'scripts', 'adventure-scene-registry.js');
const adventurePath = path.join(frontendRoot, 'public', 'ai-workspace', 'scripts', 'ai-workspace-adventure.js');
const cssPath = path.join(frontendRoot, 'public', 'ai-workspace', 'styles', 'adventure-v2.css');
const viewports = [
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1366, height: 768, label: '1366x768' },
];
const scenes = [
  {
    id: 'mist_valley',
    displayName: '雾谷',
    assets: {
      background: 'mist_valley_base.webp',
      foregroundAsset: 'mist_valley_foreground.png',
      anomalyAsset: 'mist_valley_anomaly.png',
      restoredAsset: 'mist_valley_restored.png',
    },
  },
  {
    id: 'transfer_bridge',
    displayName: '迁移之桥',
    assets: {
      background: 'transfer_bridge_base.webp',
      foregroundAsset: 'transfer_bridge_foreground.png',
      anomalyAsset: 'transfer_bridge_anomaly.png',
      restoredAsset: 'transfer_bridge_restored.png',
    },
  },
  {
    id: 'boss_core',
    displayName: '核心封印场',
    assets: {
      background: 'boss_core_base.webp',
      foregroundAsset: 'boss_core_foreground.png',
      phaseOneAsset: 'boss_core_phase_one.png',
      coreExposedAsset: 'boss_core_core_exposed.png',
      restoredAsset: 'boss_core_restored.png',
    },
  },
  {
    id: 'harvest_treasury',
    displayName: '丰穗宝库与烟火高台',
    assets: {
      background: 'harvest_treasury_base.webp',
      foregroundAsset: 'harvest_treasury_foreground.png',
      rewardRevealAsset: 'harvest_treasury_reward_reveal.png',
      fireworksReadyAsset: 'harvest_treasury_fireworks_ready.png',
    },
  },
];

const checks = [];
const screenshots = [];
const loadRecords = [];
const fallbackRecords = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const journeyRecords = [];

await mkdir(output, { recursive: true });

function check(name, passed, detail = {}) {
  checks.push({ name, passed: Boolean(passed), detail });
}

const registrySource = await readFile(registryPath, 'utf8');
const adventureSource = await readFile(adventurePath, 'utf8');
const cssSource = await readFile(cssPath, 'utf8');
const resourceManifest = [];

check(
  '用户侧正式名称统一为回声书阁',
  registrySource.includes("name: '回声书阁'")
    && !registrySource.includes('回声档案馆')
    && !adventureSource.includes('回声档案馆'),
);

for (const scene of scenes) {
  const start = registrySource.indexOf(`id: '${scene.id}'`);
  const end = registrySource.indexOf('\n        {', start + 1);
  const block = start >= 0 ? registrySource.slice(start, end >= 0 ? end : registrySource.length) : '';
  check(`${scene.displayName} 已进入统一场景注册表`, start >= 0);
  check(`${scene.displayName} 不再使用 fallback 身份`, block.includes('isFallback: false'));
  for (const [field, filename] of Object.entries(scene.assets)) {
    const absolute = path.join(sceneRoot, filename);
    let info = null;
    try {
      await access(absolute);
      info = await stat(absolute);
    } catch {
      // Recorded by the checks below.
    }
    resourceManifest.push({
      sceneId: scene.id,
      field,
      filename,
      bytes: info?.size || 0,
      exists: Boolean(info),
      width: 1920,
      height: 1080,
      format: filename.endsWith('.webp') ? 'webp' : 'png',
      alpha: filename.endsWith('.png'),
      sha256: info
        ? createHash('sha256').update(await readFile(absolute)).digest('hex')
        : '',
    });
    check(`${filename} 存在且非空`, Boolean(info && info.size > 8_000), {
      path: absolute,
      bytes: info?.size || 0,
    });
    check(`${scene.displayName} 注册 ${field}`, block.includes(`${field}: 'scenes/${filename}'`), {
      filename,
    });
  }
}

check('BOSS 使用真实状态映射到 boss_core', /state === 'BOSS'[\s\S]{0,120}'boss_core'/.test(adventureSource));
check('宝库与完成态映射到 harvest_treasury', /state === 'TREASURY'[\s\S]{0,180}'harvest_treasury'/.test(adventureSource));
check('Boss 美术读取真实 boss_stage', adventureSource.includes('boss_stage'));
check('Boss 阶段一正式层已接入', adventureSource.includes('phaseOneAsset'));
check('Boss 核心显露正式层已接入', adventureSource.includes('coreExposedAsset'));
check('奖励揭示正式层已接入', adventureSource.includes('rewardRevealAsset'));
check('烟火就绪正式层已接入', adventureSource.includes('fireworksReadyAsset'));
check('下一场景基底走统一预加载', adventureSource.includes('preloadSceneBase'));
check('Boss 资源走统一预加载', adventureSource.includes('preloadBossAssets'));
check('Boss 透明层按真实阶段渐进预加载', (
  adventureSource.includes('preloadBossAssets(stage)')
  && adventureSource.includes('stage === 1')
  && !adventureSource.includes("['foregroundAsset', 'phaseOneAsset', 'coreExposedAsset', 'restoredAsset']")
));
check('仅渲染当前透明状态层', adventureSource.includes('sceneArtSelection'));
check('基底保留加载失败降级', adventureSource.includes('data-scene-base-fallback'));
check('状态层共用正式 CSS', cssSource.includes('.shiguang-scene-art-state'));

await writeFile(
  path.join(output, 'resource-manifest.json'),
  `${JSON.stringify(resourceManifest, null, 2)}\n`,
  'utf8',
);

if (staticOnly) {
  const failed = checks.filter((item) => !item.passed);
  const report = {
    status: failed.length ? 'FAIL' : 'PASS',
    mode: 'static',
    checks: checks.length,
    failed: failed.map((item) => item.name),
  };
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
} else {
  const browser = await chromium.launch({ headless: true });

  function attachDiagnostics(page, journey) {
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push({ journey, text: message.text() });
    });
    page.on('pageerror', (error) => pageErrors.push({ journey, message: error.message }));
    page.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push({ journey, status: response.status(), url: response.url() });
      }
    });
  }

  async function registerAndLogin(context, page, label) {
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const username = `scene_art_2_${label}_${stamp}`;
    const password = 'SceneArt!2026';
    const register = await context.request.post(`${frontendUrl}/api/auth/register`, {
      data: { username, password, email: `${username}@example.test` },
    });
    if (!register.ok()) throw new Error(`register returned ${register.status()}: ${await register.text()}`);
    const body = await register.json();
    const account = body.data || body;
    const headers = { Authorization: `Bearer ${account.token}` };
    const onboarding = await context.request.post(`${frontendUrl}/api/profile-onboarding/start`, { headers });
    if (!onboarding.ok()) throw new Error(`onboarding start returned ${onboarding.status()}`);
    const onboardingBody = await onboarding.json();
    const task = onboardingBody.data || onboardingBody;
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
    await page.waitForURL((url) => url.pathname === '/ai-learning', { timeout: 20_000 });
    check(`${label} 使用真实注册与页面登录`, loginResponse.status() === 200, {
      username,
      status: loginResponse.status(),
    });
    return { headers, username };
  }

  async function drainDialogue(page) {
    for (let turn = 0; turn < 40; turn += 1) {
      const dialogue = page.locator('.shiguang-dialogue');
      if (!await dialogue.count()) return;
      const before = await dialogue.evaluate((node) => ({
        index: Number(node.dataset.queueIndex || 0),
        complete: node.dataset.lineComplete === 'true',
      }));
      await dialogue.locator('[data-action="dialogue-next"]').click();
      await page.waitForFunction(
        ({ index, complete }) => {
          const node = document.querySelector('.shiguang-dialogue');
          if (!node) return true;
          return complete
            ? Number(node.dataset.queueIndex || 0) > index
            : Number(node.dataset.queueIndex || 0) === index && node.dataset.lineComplete === 'true';
        },
        before,
        { timeout: 10_000 },
      );
    }
    throw new Error('dialogue queue did not finish');
  }

  async function settle(page) {
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      const phase = overlay?.dataset.directionPhase || '';
      return overlay
        && !overlay.classList.contains('is-busy')
        && (phase === 'dialogue' || phase === 'interactive');
    }, null, { timeout: 20_000 });
    if (await page.locator('.shiguang-dialogue').count()) await drainDialogue(page);
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      return overlay
        && !overlay.classList.contains('is-busy')
        && overlay.dataset.directionPhase === 'interactive'
        && !document.querySelector('.shiguang-dialogue');
    }, null, { timeout: 20_000 });
    await page.waitForTimeout(180);
  }

  async function clickAndSettle(page, selector) {
    await page.locator(selector).click();
    await page.waitForTimeout(100);
    await settle(page);
  }

  async function chooseDestination(page, sceneId) {
    const selector = `[data-action="destination"][data-destination-id="${sceneId}"]`;
    check(`真实选路出现 ${sceneId}`, await page.locator(selector).isVisible(), { selector });
    await clickAndSettle(page, selector);
  }

  async function startJourney(page) {
    await page.locator('#adventureEntry').click();
    await page.locator('#shiguangTopic').fill('机器学习模型评估');
    await page.locator('input[name="source"][value="manual"]').check();
    await page.locator('.shiguang-schools label[data-school="wood"]').click();
    await page.locator('[data-action="confirm-school"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
    await clickAndSettle(page, '[data-action="start"]');
  }

  async function sceneMetrics(page) {
    return page.evaluate(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      const scene = document.querySelector('.shiguang-scene');
      const sceneRect = scene?.getBoundingClientRect();
      const panelRect = document.querySelector('.shiguang-panel')?.getBoundingClientRect();
      const layers = [...document.querySelectorAll('.shiguang-scene-art-layer')].map((node) => ({
        kind: node.dataset.layerKind || '',
        state: node.dataset.layerState || '',
        src: node.getAttribute('src') || '',
        loaded: node.complete && node.naturalWidth > 0,
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
        hidden: node.hidden,
        opacity: Number.parseFloat(getComputedStyle(node).opacity),
      }));
      const roles = [...document.querySelectorAll(
        '.shiguang-player, .shiguang-mascot, .shiguang-enemy, .shiguang-boss-character',
      )].map((node) => ({
        className: node.className,
        src: node.getAttribute('src') || '',
        performance: node.dataset.performanceState || '',
      }));
      const route = Object.keys(localStorage)
        .filter((key) => key.startsWith('kaki_adventure_route_v1:'))
        .map((key) => {
          try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
        })
        .find(Boolean);
      return {
        backendState: overlay?.dataset.state || '',
        directionPhase: overlay?.dataset.directionPhase || '',
        sceneId: overlay?.dataset.sceneId || '',
        sceneLocation: scene?.dataset.sceneLocation || '',
        sceneState: scene?.dataset.sceneState || '',
        fallback: scene?.dataset.sceneFallback || '',
        layers,
        roles,
        route,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        sceneRect: sceneRect ? {
          x: sceneRect.x,
          y: sceneRect.y,
          width: sceneRect.width,
          height: sceneRect.height,
        } : null,
        panelRect: panelRect ? {
          x: panelRect.x,
          y: panelRect.y,
          width: panelRect.width,
          height: panelRect.height,
        } : null,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        celebrationBursts: document.querySelectorAll('.shiguang-celebration-bursts i').length,
        text: document.querySelector('.shiguang-panel')?.innerText || '',
        resourceTimings: performance.getEntriesByType('resource')
          .filter((entry) => /(mist_valley|transfer_bridge|boss_core|harvest_treasury)_/.test(entry.name))
          .map((entry) => ({
            name: entry.name,
            durationMs: Number(entry.duration.toFixed(2)),
            transferSize: entry.transferSize,
            decodedBodySize: entry.decodedBodySize,
          })),
      };
    });
  }

  async function capture(page, label) {
    await page.waitForFunction(() => [...document.querySelectorAll('.shiguang-scene-art-layer')]
      .every((node) => node.complete), null, { timeout: 12_000 });
    await page.waitForTimeout(250);
    const metrics = await sceneMetrics(page);
    const filename = `${label}-${metrics.viewport.width}x${metrics.viewport.height}.png`;
    const absolute = path.join(output, filename);
    await page.screenshot({ path: absolute, fullPage: false });
    screenshots.push(absolute);
    loadRecords.push({ label, metrics });
    return metrics;
  }

  function assertScene(label, metrics, sceneId, sceneState, activeLayerState = '') {
    check(`${label} 映射到 ${sceneId}`, metrics.sceneLocation === sceneId, metrics);
    check(`${label} 呈现状态为 ${sceneState}`, metrics.sceneState === sceneState, metrics);
    check(`${label} 使用正式基底而非 fallback`, metrics.fallback === 'false', metrics);
    check(`${label} 正式图层全部加载`, metrics.layers.length >= 1 && metrics.layers.every((layer) => layer.loaded), metrics.layers);
    check(`${label} 没有横向溢出`, !metrics.overflow, metrics);
    check(`${label} 场景覆盖完整舞台`, (
      metrics.sceneRect
      && metrics.sceneRect.width >= metrics.viewport.width - 2
      && metrics.sceneRect.y <= 64
      && metrics.sceneRect.height >= metrics.viewport.height - 64
    ), metrics.sceneRect || {});
    if (activeLayerState) {
      check(`${label} 只挂载当前 ${activeLayerState} 状态层`, (
        metrics.layers.filter((layer) => layer.kind !== 'foreground').length === 1
        && metrics.layers.some((layer) => layer.state === activeLayerState)
      ), metrics.layers);
    } else {
      check(`${label} 普通态不批量解码状态层`, (
        metrics.layers.filter((layer) => layer.kind !== 'foreground').length === 0
      ), metrics.layers);
    }
  }

  async function auditViewports(page, sceneId, phase) {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const metrics = await capture(page, `viewport-audit-${sceneId}-${phase}`);
      check(`${sceneId} 在 ${viewport.label} 保持全屏`, (
        metrics.sceneId === sceneId
        && !metrics.overflow
        && metrics.sceneRect?.width >= viewport.width - 2
        && metrics.sceneRect?.y <= 64
        && metrics.sceneRect?.height >= viewport.height - 64
      ), metrics);
      check(`${sceneId} 在 ${viewport.label} 底部面板未越界`, (
        metrics.panelRect
        && metrics.panelRect.y >= 0
        && metrics.panelRect.y + metrics.panelRect.height <= viewport.height + 2
      ), metrics.panelRect || {});
    }
  }

  async function induceLayerFailure(page, label) {
    const before = await page.evaluate(() => window.__kakiSceneArtEvents.length);
    const layer = page.locator('.shiguang-scene-art-state').first();
    if (!await layer.count()) {
      check(`${label} 有可测试的透明状态层`, false);
      return;
    }
    await layer.evaluate((node) => {
      node.src = `/ai-workspace/assets/adventure/scenes/__missing_${Date.now()}.png`;
    });
    await page.waitForFunction((count) => window.__kakiSceneArtEvents.length > count, before, { timeout: 5_000 });
    const record = await page.evaluate(() => window.__kakiSceneArtEvents.at(-1));
    const hidden = await layer.evaluate((node) => node.hidden || getComputedStyle(node).display === 'none');
    fallbackRecords.push({ label, record, hidden });
    check(`${label} 透明层失败会隐藏且不留下破图`, hidden && record?.type === 'asset-fallback', {
      record,
      hidden,
    });
  }

  async function reopen(page, expectedScene, expectedState) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#adventureEntry').click();
    await settle(page);
    const metrics = await sceneMetrics(page);
    check(`刷新重进恢复 ${expectedScene}`, (
      metrics.sceneId === expectedScene && metrics.sceneState === expectedState
    ), metrics);
    const entranceEvents = await page.evaluate(() => window.__kakiDirectionEvents
      .filter((item) => item.type === 'character' && item.performance === 'entering').length);
    check(`${expectedScene} 刷新恢复不重播角色入场`, entranceEvents === 0, { entranceEvents });
    return metrics;
  }

  async function ordinaryChatRegression(page) {
    if (await page.locator('.shiguang-overlay').count()) {
      await page.locator('[data-action="leave"], [data-action="return"]').first().click();
    }
    const assistantBefore = await page.locator('#messages .msg.assistant').count();
    await page.locator('#input').fill('请用一句话说明验证集与测试集的区别。');
    const responsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/chat/stream') && response.request().method() === 'POST'
    ), { timeout: 30_000 });
    await page.locator('#send').click();
    const response = await responsePromise;
    await page.waitForFunction(
      (count) => document.querySelectorAll('#messages .msg.assistant').length > count,
      assistantBefore,
      { timeout: 45_000 },
    );
    const assistantAfter = await page.locator('#messages .msg.assistant').count();
    check('离开游戏后普通 AI 对话仍走真实流式接口', response.status() === 200 && assistantAfter > assistantBefore, {
      status: response.status(),
      assistantBefore,
      assistantAfter,
    });
  }

  async function runMistJourney() {
    const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: 1 });
    const page = await context.newPage();
    attachDiagnostics(page, 'mist');
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
      const account = await registerAndLogin(context, page, 'mist');
      await startJourney(page);
      await chooseDestination(page, 'echo_archive');
      await clickAndSettle(page, '[data-action="continue"]');
      await chooseDestination(page, 'mist_valley');
      const normal = await capture(page, 'mist-valley-normal');
      assertScene('雾谷普通态', normal, 'mist_valley', 'normal');
      await auditViewports(page, 'mist_valley', 'normal');

      await clickAndSettle(page, '[data-action="continue"]');
      await chooseDestination(page, 'mist_valley');
      await clickAndSettle(page, '[data-action="method"][data-method="explain"]');
      const challengeDestination = await sceneMetrics(page);
      check('雾谷试炼选路已使用异常层', challengeDestination.sceneState === 'anomaly', challengeDestination);
      await chooseDestination(page, 'mist_valley');
      await page.locator('.shiguang-answer textarea').fill('只看训练分数就足够');
      await clickAndSettle(page, '.shiguang-answer [type="submit"]');
      const anomaly = await capture(page, 'mist-valley-anomaly');
      assertScene('雾谷异常态', anomaly, 'mist_valley', 'anomaly', 'anomaly');
      await chooseDestination(page, 'mist_valley');
      await clickAndSettle(page, '.shiguang-options [data-action="answer"]:first-child');
      const restored = await capture(page, 'mist-valley-restored');
      assertScene('雾谷修复态', restored, 'mist_valley', 'restored', 'restored');
      await reopen(page, 'mist_valley', 'restored');
      await induceLayerFailure(page, '雾谷修复态');
      journeyRecords.push({ journey: 'mist', username: account.username, final: await sceneMetrics(page) });
    } finally {
      await context.close();
    }
  }

  async function runBridgeBossTreasuryJourney() {
    const context = await browser.newContext({ viewport: viewports[1], deviceScaleFactor: 1 });
    const page = await context.newPage();
    attachDiagnostics(page, 'bridge-boss-treasury');
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
      const account = await registerAndLogin(context, page, 'bridge_boss');
      await startJourney(page);
      await chooseDestination(page, 'mirror_lake');
      await clickAndSettle(page, '[data-action="continue"]');
      await chooseDestination(page, 'transfer_bridge');
      const normal = await capture(page, 'transfer-bridge-normal');
      assertScene('迁移之桥普通态', normal, 'transfer_bridge', 'normal');

      await clickAndSettle(page, '[data-action="continue"]');
      await chooseDestination(page, 'transfer_bridge');
      await clickAndSettle(page, '[data-action="method"][data-method="explain"]');
      const anomalyDestination = await capture(page, 'transfer-bridge-anomaly');
      assertScene('迁移之桥异常态', anomalyDestination, 'transfer_bridge', 'anomaly', 'anomaly');
      await chooseDestination(page, 'transfer_bridge');
      await page.locator('.shiguang-answer textarea').fill('泛化能力需要在未见新数据上检验，避免过拟合');
      await clickAndSettle(page, '.shiguang-answer [type="submit"]');
      const restored = await capture(page, 'transfer-bridge-restored');
      assertScene('迁移之桥修复态', restored, 'transfer_bridge', 'restored', 'restored');
      await auditViewports(page, 'transfer_bridge', 'restored');

      await chooseDestination(page, 'transfer_bridge');
      await clickAndSettle(page, '[data-action="continue"]');
      await chooseDestination(page, 'transfer_bridge');
      await clickAndSettle(page, '.shiguang-options [data-action="answer"]:first-child');
      const bossNormal = await capture(page, 'boss-core-normal');
      assertScene('Boss 核心抵达态', bossNormal, 'boss_core', 'boss_normal');
      check('Boss 核心有真实 Boss 角色资产', bossNormal.roles.some((role) => role.src.includes('boss_')), bossNormal.roles);

      await chooseDestination(page, 'transfer_bridge');
      await page.locator('.shiguang-answer textarea').fill('泛化能力是模型在未见新数据上的预测表现');
      await clickAndSettle(page, '.shiguang-answer [type="submit"]');
      const phaseOne = await capture(page, 'boss-core-phase-one');
      assertScene('Boss 阶段一', phaseOne, 'boss_core', 'boss_phase_one', 'boss_phase_one');

      await chooseDestination(page, 'transfer_bridge');
      await clickAndSettle(page, '.shiguang-options [data-action="answer"]:first-child');
      const coreExposed = await capture(page, 'boss-core-exposed');
      assertScene('Boss 核心显露', coreExposed, 'boss_core', 'boss_core_exposed', 'boss_core_exposed');
      await auditViewports(page, 'boss_core', 'core-exposed');
      await reopen(page, 'boss_core', 'boss_core_exposed');

      await chooseDestination(page, 'transfer_bridge');
      await page.locator('.shiguang-answer textarea').fill('这是过拟合，我会使用早停来改善泛化');
      await page.locator('.shiguang-answer [type="submit"]').click();
      await page.waitForFunction(
        () => document.querySelector('.shiguang-scene')?.dataset.sceneState === 'boss_restored',
        null,
        { timeout: 12_000 },
      );
      const bossRestored = await capture(page, 'boss-core-restored');
      assertScene('Boss 修复静拍', bossRestored, 'boss_core', 'boss_restored', 'boss_restored');
      await settle(page);
      const treasuryArrival = await capture(page, 'harvest-treasury-arrival');
      assertScene('宝库抵达态', treasuryArrival, 'harvest_treasury', 'treasury_arrival');
      await auditViewports(page, 'harvest_treasury', 'arrival');

      await chooseDestination(page, 'transfer_bridge');
      const reward = await capture(page, 'harvest-treasury-reward-reveal');
      assertScene('宝库奖励揭示态', reward, 'harvest_treasury', 'reward_reveal', 'reward_reveal');
      check('奖励仍由玩家主动领取且未自动装备', (
        await page.locator('[data-action="claim"]').isVisible()
        && !reward.text.includes('已装备')
      ), { text: reward.text });

      await clickAndSettle(page, '[data-action="claim"]');
      const fireworks = await capture(page, 'harvest-treasury-fireworks-ready');
      assertScene('烟火高台就绪态', fireworks, 'harvest_treasury', 'fireworks_ready', 'fireworks_ready');
      check('既有烟火程序仍在运行', fireworks.celebrationBursts === 3, {
        celebrationBursts: fireworks.celebrationBursts,
      });
      await induceLayerFailure(page, '烟火高台就绪态');
      await ordinaryChatRegression(page);
      journeyRecords.push({
        journey: 'bridge-boss-treasury',
        username: account.username,
        final: await sceneMetrics(page),
      });
    } finally {
      await context.close();
    }
  }

  try {
    await runMistJourney();
    await runBridgeBossTreasuryJourney();
  } catch (error) {
    check('真实浏览器旅程无未处理异常', false, {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    await browser.close();
  }

  check('真实旅程无页面脚本异常', pageErrors.length === 0, { pageErrors });
  check('真实旅程无 5xx 响应', failedResponses.length === 0, { failedResponses });
  check('正式资源无控制台加载错误', consoleErrors.length === 0, { consoleErrors });
  check('两条真实旅程均完成', journeyRecords.length === 2, { journeyRecords });

  const failed = checks.filter((item) => !item.passed);
  const report = {
    status: failed.length ? 'FAIL' : 'PASS',
    mode: 'browser',
    generatedAt: new Date().toISOString(),
    frontendUrl,
    checks: checks.length,
    passed: checks.length - failed.length,
    failed,
    screenshots,
    loadRecords,
    fallbackRecords,
    journeyRecords,
    consoleErrors,
    pageErrors,
    failedResponses,
  };
  await Promise.all([
    writeFile(path.join(output, 'game-scene-art-batch2-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(path.join(output, 'scene-art-batch2-load-fallback-records.json'), `${JSON.stringify({
      loadRecords,
      fallbackRecords,
      consoleErrors,
      pageErrors,
      failedResponses,
    }, null, 2)}\n`, 'utf8'),
  ]);
  console.log(JSON.stringify({
    status: report.status,
    checks: report.checks,
    passed: report.passed,
    failed: failed.map((item) => item.name),
    screenshots: screenshots.length,
    fallbackRecords: fallbackRecords.length,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
}
