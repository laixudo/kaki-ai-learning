/* global document, getComputedStyle, performance, window */

import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const frontendRoot = path.join(projectRoot, 'frontend');
const publicRoot = path.join(frontendRoot, 'public', 'ai-workspace');
const badgeRoot = path.join(publicRoot, 'assets', 'adventure', 'badges');
const registryPath = path.join(publicRoot, 'scripts', 'adventure-badge-registry.js');
const adventurePath = path.join(publicRoot, 'scripts', 'ai-workspace-adventure.js');
const apiPath = path.join(publicRoot, 'scripts', 'ai-workspace-api.js');
const cssPath = path.join(publicRoot, 'styles', 'adventure-v2.css');
const htmlPath = path.join(publicRoot, 'ai-workspace-test.html');
const kernelPath = path.join(frontendRoot, 'src', 'components', 'ai-learning', 'AiWorkspaceKernel.tsx');
const servicePath = path.join(projectRoot, 'backend', 'services', 'harvest_adventure.py');
const routerPath = path.join(projectRoot, 'backend', 'routers', 'harvest_adventure.py');
const frontendUrl = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const output = process.env.KAKI_BADGE_REWARD_EVIDENCE
  || path.join(projectRoot, 'evidence', 'game-badge-reward-20260730');
const staticOnly = process.argv.includes('--static-only');
const viewports = [
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1366, height: 768, label: '1366x768' },
];
const assets = [
  { name: 'adventure_summary_badge.png', width: 768, height: 768, kind: 'badge-body' },
  { name: 'adventure_summary_silhouette.png', width: 768, height: 768, kind: 'silhouette' },
  { name: 'badge_reveal_halo.png', width: 1024, height: 1024, kind: 'reveal-auxiliary' },
];

const checks = [];
const screenshots = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const directionEvents = [];
const apiRecords = [];
const assetManifest = [];

await mkdir(output, { recursive: true });

function check(name, passed, detail = {}) {
  checks.push({ name, passed: Boolean(passed), detail });
}

function unwrap(body) {
  return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
}

function pngMetadata(buffer) {
  if (buffer?.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.length < 26) return null;
  const colorType = buffer.readUInt8(25);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType,
    transparent: colorType === 4 || colorType === 6,
  };
}

async function readable(file) {
  try {
    await access(file);
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

const [registrySource, adventureSource, apiSource, cssSource, htmlSource, kernelSource, serviceSource, routerSource] = await Promise.all([
  readable(registryPath),
  readable(adventurePath),
  readable(apiPath),
  readable(cssPath),
  readable(htmlPath),
  readable(kernelPath),
  readable(servicePath),
  readable(routerPath),
]);

check('真实奖励目录准确识别为 adventure_summary 一种', (
  serviceSource.includes('REWARD_CATALOG_ID = "adventure_summary"')
  && serviceSource.includes('"catalog_count": 1')
  && (registrySource.match(/id:\s*'adventure_summary'/g) || []).length === 1
));
check('统一勋章注册表具备全部要求字段', [
  'id', 'displayName', 'description', 'image', 'silhouette', 'revealEffect',
  'rarityClass', 'category', 'frameStyle', 'accentClass', 'equipSlot', 'fallbackIcon',
].every((field) => registrySource.includes(`${field}:`)));
check('正式入口在冒险主程序之前加载旅印注册表', (
  htmlSource.indexOf('adventure-badge-registry.js') > htmlSource.indexOf('adventure-spell-director.js')
  && htmlSource.indexOf('adventure-badge-registry.js') < htmlSource.indexOf('ai-workspace-adventure.js')
  && kernelSource.indexOf("'adventure-badge-registry.js'") > kernelSource.indexOf("'adventure-spell-director.js'")
  && kernelSource.indexOf("'adventure-badge-registry.js'") < kernelSource.indexOf("'ai-workspace-adventure.js'")
));
check('原程序临时勋章绘制已移除', (
  !adventureSource.includes('shiguang-item-medal')
  && !cssSource.includes('shiguang-medal-stamp')
  && !cssSource.includes('shiguang-complete-seal')
));
check('收藏 装备 替换 卸下均调用真实奖励接口', (
  apiSource.includes('/api/adventure/rewards')
  && apiSource.includes('/api/adventure/rewards/equip')
  && apiSource.includes('/api/adventure/rewards/unequip')
  && routerSource.includes('@router.get("/rewards")')
  && routerSource.includes('@router.post("/rewards/equip")')
  && routerSource.includes('@router.post("/rewards/unequip")')
));
check('领取不自动装备且装备元数据附着既有 GeneratedItem', (
  serviceSource.includes('"equipped": False')
  && serviceSource.includes('raw_data["_adventure_reward"]')
  && !serviceSource.includes('class AdventureBadge')
));
check('具体行为认可来自真实 timeline', (
  serviceSource.includes('event.get("decision") == "needs_review"')
  && adventureSource.includes('snapshot.reward.acquired_reason')
));
check('获得演出由安静余韵 对白认可 旅印浮现 用户选择组成', (
  adventureSource.includes('if (!await this.wait(900, token)) return')
  && adventureSource.includes('this.revealReward()')
  && adventureSource.includes('data-action="reward-collect"')
  && adventureSource.includes('data-action="reward-collect-equip"')
  && adventureSource.includes('data-action="reward-later"')
));
check('减少动态模式下旅印仍直接可见', (
  cssSource.includes('@media (prefers-reduced-motion: reduce)')
  && cssSource.includes('.shiguang-reward-display.is-revealed .shiguang-reward-badge { opacity: 1')
));
check('正式资源失败时隐藏破图并展示注册表 fallback', (
  adventureSource.includes('handleBadgeAssetError')
  && adventureSource.includes('image.hidden = true')
  && adventureSource.includes('badge.fallbackIcon')
));

for (const asset of assets) {
  const absolute = path.join(badgeRoot, asset.name);
  let info = null;
  let buffer = null;
  try {
    info = await stat(absolute);
    buffer = await readFile(absolute);
  } catch {
    // Recorded below.
  }
  const metadata = buffer ? pngMetadata(buffer) : null;
  assetManifest.push({
    ...asset,
    path: `/ai-workspace/assets/adventure/badges/${asset.name}`,
    bytes: info?.size || 0,
    format: 'PNG',
    transparent: Boolean(metadata?.transparent),
    actualWidth: metadata?.width || 0,
    actualHeight: metadata?.height || 0,
    source: asset.kind === 'silhouette'
      ? 'OpenAI imagegen badge body; local alpha-safe silhouette derivative'
      : 'OpenAI imagegen; local alpha extraction and edge cleanup',
    sha256: buffer ? createHash('sha256').update(buffer).digest('hex') : '',
  });
  check(`${asset.name} 正式资源存在且具有透明通道`, Boolean(
    info && info.size > 8_000
    && metadata?.transparent
    && metadata.width === asset.width
    && metadata.height === asset.height
  ), { bytes: info?.size || 0, metadata });
  check(`${asset.name} 已由统一注册表引用`, registrySource.includes(asset.name));
}

await writeFile(path.join(output, 'resource-manifest.json'), `${JSON.stringify(assetManifest, null, 2)}\n`, 'utf8');

if (!staticOnly) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: 1 });
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push({ text: message.text() });
  });
  page.on('pageerror', (error) => pageErrors.push({ message: error.message }));
  page.on('response', (response) => {
    if (response.status() >= 500) failedResponses.push({ status: response.status(), url: response.url() });
  });
  await page.addInitScript(() => {
    window.__kakiDirectionEvents = [];
    document.addEventListener('shiguang:direction', (event) => {
      window.__kakiDirectionEvents.push({ ...event.detail, at: performance.now() });
    });
  });

  async function api(method, url, headers, data) {
    const response = await context.request.fetch(`${frontendUrl}${url}`, { method, headers, data });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    apiRecords.push({ method, url, status: response.status(), body });
    if (!response.ok()) throw new Error(`${method} ${url} returned ${response.status()}: ${text}`);
    return unwrap(body);
  }

  async function registerAndLogin() {
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const username = `badge_reward_${stamp}`;
    const password = 'BadgeReward!2026';
    const account = await api('POST', '/api/auth/register', undefined, {
      username,
      password,
      email: `${username}@example.test`,
    });
    const headers = { Authorization: `Bearer ${account.token}` };
    const onboarding = await api('POST', '/api/profile-onboarding/start', headers);
    await api('POST', '/api/profile-onboarding/skip', headers, { task_id: onboarding.task_id });
    await page.goto(`${frontendUrl}/login?redirect=/ai-learning`, { waitUntil: 'networkidle' });
    await page.getByTestId('auth-phone').fill(username);
    await page.getByTestId('auth-password').fill(password);
    const [loginResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/auth/login')),
      page.getByTestId('auth-submit').click(),
    ]);
    await page.waitForURL((url) => url.pathname === '/ai-learning', { timeout: 20_000 });
    check('使用真实注册与渲染登录表单进入正式入口', loginResponse.status() === 200, { username });
    return { username, headers };
  }

  async function drainDialogue() {
    for (let turn = 0; turn < 50; turn += 1) {
      const dialogue = page.locator('.shiguang-dialogue');
      if (!await dialogue.count()) return;
      const before = await dialogue.evaluate((node) => ({
        index: Number(node.dataset.queueIndex || 0),
        complete: node.dataset.lineComplete === 'true',
      }));
      await dialogue.locator('[data-action="dialogue-next"]').click();
      await page.waitForFunction(({ index, complete }) => {
        const node = document.querySelector('.shiguang-dialogue');
        if (!node) return true;
        return complete
          ? Number(node.dataset.queueIndex || 0) > index
          : Number(node.dataset.queueIndex || 0) === index && node.dataset.lineComplete === 'true';
      }, before, { timeout: 10_000 });
    }
    throw new Error('dialogue queue did not finish');
  }

  async function settle() {
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      const phase = overlay?.dataset.directionPhase || '';
      return overlay && !overlay.classList.contains('is-busy') && (phase === 'dialogue' || phase === 'interactive');
    }, null, { timeout: 30_000 });
    if (await page.locator('.shiguang-dialogue').count()) await drainDialogue();
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      return overlay
        && !overlay.classList.contains('is-busy')
        && overlay.dataset.directionPhase === 'interactive'
        && !document.querySelector('.shiguang-dialogue');
    }, null, { timeout: 30_000 });
  }

  async function clickAndSettle(selector) {
    await page.locator(selector).first().click();
    await settle();
  }

  async function choose(id = 'stay') {
    const selector = id === 'stay'
      ? '[data-action="destination"][data-destination-kind="stay"]'
      : `[data-action="destination"][data-destination-id="${id}"]`;
    await clickAndSettle(selector);
  }

  async function capture(name) {
    const absolute = path.join(output, name);
    await page.screenshot({ path: absolute, fullPage: false });
    screenshots.push(absolute);
  }

  async function rewards(headers) {
    return api('GET', '/api/adventure/rewards', headers);
  }

  async function finishSecondJourney(headers) {
    let game = await api('POST', '/api/adventure/start', headers, {
      topic: 'Python 循环',
      magic_school: 'water',
      source_ids: [],
      source_type: 'manual',
      force_new: true,
    });
    const runId = game.run_id;
    const advance = async (action, payload = {}) => {
      game = await api('POST', '/api/adventure/advance', headers, { run_id: runId, action, payload });
      return game;
    };
    await advance('continue');
    await advance('continue');
    await advance('choose_strategy', { choice: 'practice', method: 'practice' });
    await advance('submit', { answer: game.content.practice.trial.options[0] });
    await advance('continue');
    await advance('submit', { answer: '我会设置超时和结束条件，避免 while 无限运行' });
    await advance('submit', { answer: 'for 用于遍历，while 由条件控制' });
    await advance('submit', { answer: game.content.boss[1].options[0] });
    await advance('submit', { answer: '使用 while 检查状态，并设置次数 超时 和 break 结束' });
    check('第二次真实旅程抵达丰穗宝库', game.state === 'TREASURY', { runId, state: game.state });
    const claimed = await advance('claim');
    return { runId, artifactId: claimed.artifact_id };
  }

  try {
    const account = await registerAndLogin();
    await page.locator('#adventureEntry').click();
    await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
    await page.locator('.shiguang-panel').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.locator('.shiguang-reward-tile.is-locked .shiguang-badge-portrait.is-silhouette img').waitFor({ state: 'visible' });
    check('未获得轮廓在营地收藏架展示', (
      await page.locator('.shiguang-reward-tile.is-locked .shiguang-badge-portrait.is-silhouette img').isVisible()
    ));
    await capture('badge-silhouette-locked.png');

    await page.locator('#shiguangTopic').fill('机器学习模型评估');
    await page.locator('input[name="source"][value="manual"]').check();
    await page.locator('.shiguang-schools label[data-school="fire"]').click();
    await page.locator('.shiguang-panel').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.locator('[data-action="confirm-school"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="confirm-school"]')?.textContent.includes('已确认'));
    await clickAndSettle('[data-action="start"]');
    await choose('echo_archive');
    await clickAndSettle('[data-action="continue"]');
    await choose();
    await clickAndSettle('[data-action="continue"]');
    await choose();
    await clickAndSettle('[data-action="method"][data-method="explain"]');
    await choose();

    await page.locator('.shiguang-answer textarea').fill('不知道');
    await clickAndSettle('.shiguang-answer [type="submit"]');
    await choose();
    await clickAndSettle('.shiguang-options [data-action="answer"]');
    await choose();
    await clickAndSettle('.shiguang-options [data-action="answer"]');
    await choose();
    await page.locator('.shiguang-answer textarea').fill('泛化能力是模型在未见新数据上的预测表现');
    await clickAndSettle('.shiguang-answer [type="submit"]');
    await choose();
    await clickAndSettle('.shiguang-options [data-action="answer"]');
    await choose();

    const beforeFinalEvents = await page.evaluate(() => window.__kakiDirectionEvents.length);
    await page.locator('.shiguang-answer textarea').fill('这是过拟合，我会使用早停改善泛化');
    await page.locator('.shiguang-answer [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.shiguang-scene')?.dataset.sceneState === 'boss_restored', null, { timeout: 20_000 });
    await capture('boss-quiet-aftermath.png');
    await settle();
    const finalEvents = await page.evaluate((index) => window.__kakiDirectionEvents.slice(index), beforeFinalEvents);
    directionEvents.push(...finalEvents);
    check('Boss 后先出现安静修复再进入奖励', (
      finalEvents.some((event) => event.type === 'boss-restored')
      && finalEvents.some((event) => event.type === 'reward-reveal')
      && finalEvents.findIndex((event) => event.type === 'boss-restored') < finalEvents.findIndex((event) => event.type === 'reward-reveal')
    ), { finalEvents });
    await choose();
    check('柿小吉认可引用真实补救行为', (
      (await page.locator('[data-reward-candidate] p').first().textContent()).includes('证据不足后补全')
    ));
    await page.waitForFunction(() => {
      const badge = document.querySelector('[data-reward-display].is-revealed .shiguang-reward-badge');
      return badge && Number(getComputedStyle(badge).opacity) > 0.9;
    }, null, { timeout: 5_000 });
    const revealVisual = await page.evaluate(() => {
      const badge = document.querySelector('[data-reward-display].is-revealed .shiguang-reward-badge');
      const candidate = document.querySelector('[data-reward-candidate]');
      const rect = badge?.getBoundingClientRect();
      return {
        opacity: badge ? Number(getComputedStyle(badge).opacity) : 0,
        badgeInsideViewport: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight),
        candidateVisible: Boolean(candidate && candidate.getBoundingClientRect().height > 0),
      };
    });
    check('正式旅印在宝库浮现且用户仍未自动装备', (
      revealVisual.opacity > 0.9
      && revealVisual.badgeInsideViewport
      && revealVisual.candidateVisible
      && (await rewards(account.headers)).equipped === null
    ), revealVisual);
    await capture('badge-reveal-1920x1080.png');
    await page.locator('[data-action="reward-candidate-detail"]').click();
    check('候选详情展示类别 槽位与说明', await page.locator('.shiguang-reward-candidate-detail').isVisible());

    await page.locator('[data-action="leave"]').click();
    await page.locator('#adventureEntry').click();
    await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
    await settle();
    check('候选演出中退出重进不丢奖励且仍未收藏装备', (
      await page.locator('[data-reward-candidate]').isVisible()
      && (await rewards(account.headers)).owned_count === 0
      && (await rewards(account.headers)).equipped === null
    ));

    const firstRun = (await api('GET', '/api/adventure/current', account.headers)).run_id;
    const claimRequests = [];
    const recordClaimRequest = (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/adventure/advance')) claimRequests.push(request.url());
    };
    page.on('request', recordClaimRequest);
    const [claimResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/adventure/advance')),
      page.locator('[data-action="reward-collect"]').evaluate((button) => {
        button.click();
        button.click();
        button.click();
      }),
    ]);
    await page.waitForTimeout(250);
    page.off('request', recordClaimRequest);
    check('收入收藏调用真实领取接口', claimResponse.status() === 200);
    check('领取按钮连续三击只产生一次真实请求', claimRequests.length === 1, { claimRequests });
    await settle();
    let collection = await rewards(account.headers);
    const first = collection.items[0];
    check('领取后真实收藏且仍未装备', collection.owned_count === 1 && collection.equipped === null && first.collected && !first.equipped, collection);
    await page.locator('.shiguang-reward-shelf').scrollIntoViewIfNeeded();
    await capture('badge-collected.png');

    await page.locator(`[data-action="reward-detail"][data-artifact-id="${first.artifact_id}"]`).click();
    check('详情显示来源旅程 获得时间 获得原因', (
      await page.locator('.shiguang-reward-detail dt').count() >= 2
      && (await page.locator('.shiguang-reward-detail').textContent()).includes('证据不足后补全')
    ));
    await page.locator(`[data-action="reward-equip"][data-artifact-id="${first.artifact_id}"]`).click();
    await page.waitForFunction(() => document.querySelector('.shiguang-equipped-mark'));
    collection = await rewards(account.headers);
    check('用户主动装备后真实保存并显示 HUD 旅印', (
      collection.equipped?.artifact_id === first.artifact_id
      && await page.locator('.shiguang-equipped-mark img').isVisible()
    ), collection);
    await capture('badge-equipped-hud.png');

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#adventureEntry').click();
    await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.shiguang-reward-tile.is-equipped').length === 1);
    check('刷新后收藏和装备真实恢复且不重播获得演出', (
      await page.locator('.shiguang-reward-tile.is-equipped').count() === 1
      && await page.locator('[data-reward-display]').count() === 0
    ));

    const second = await finishSecondJourney(account.headers);
    const repeated = await api('POST', '/api/adventure/advance', account.headers, {
      run_id: second.runId,
      action: 'claim',
      payload: {},
    });
    collection = await rewards(account.headers);
    check('同一旅程重复领取保持同一产物且不生成第三份', (
      repeated.artifact_id === second.artifactId && collection.owned_count === 2
    ), { repeated, collection });

    await page.locator('[data-action="leave"]').click();
    await page.locator('#adventureEntry').click();
    await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
    const secondTile = page.locator(`[data-action="reward-detail"][data-artifact-id="${second.artifactId}"]`);
    await secondTile.click();
    await page.locator(`[data-action="reward-equip"][data-artifact-id="${second.artifactId}"]`).click();
    await page.locator('.shiguang-reward-compare').waitFor({ state: 'visible' });
    check('同槽位已有装备时展示真实比较确认', await page.locator('.shiguang-reward-compare').isVisible());
    await page.locator('.shiguang-reward-compare').scrollIntoViewIfNeeded();
    await capture('badge-replace-confirmation.png');
    await page.locator('[data-action="reward-replace-cancel"]').click();
    collection = await rewards(account.headers);
    check('取消替换保留原装备', collection.equipped?.artifact_id === first.artifact_id, collection);

    if (await page.locator(`[data-action="reward-detail"][data-artifact-id="${second.artifactId}"]`).count()) {
      await page.locator(`[data-action="reward-detail"][data-artifact-id="${second.artifactId}"]`).click();
    }
    await page.locator(`[data-action="reward-equip"][data-artifact-id="${second.artifactId}"]`).click();
    await page.locator('.shiguang-reward-compare').waitFor({ state: 'visible' });
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/adventure/rewards/equip') && response.status() === 200),
      page.locator('[data-action="reward-replace-confirm"]').click(),
    ]);
    await page.waitForFunction((artifactId) => Number(document.querySelector('.shiguang-reward-detail')?.dataset.rewardDetail) === artifactId, second.artifactId);
    collection = await rewards(account.headers);
    check('确认替换后仅新旅印为当前装备', (
      collection.equipped?.artifact_id === second.artifactId
      && collection.items.filter((item) => item.equipped).length === 1
    ), collection);
    await page.locator('.shiguang-reward-detail').scrollIntoViewIfNeeded();
    await capture('badge-replaced.png');

    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/adventure/rewards/unequip') && response.status() === 200),
      page.locator('[data-action="reward-unequip"]').click(),
    ]);
    await page.waitForFunction(() => document.querySelector('.shiguang-reward-detail small')?.textContent.includes('尚未装备'));
    collection = await rewards(account.headers);
    check('卸下后真实恢复为无装备且收藏仍保留', (
      collection.equipped === null && collection.owned_count === 2
    ), collection);
    await page.locator('.shiguang-reward-detail').scrollIntoViewIfNeeded();
    await capture('badge-unequipped.png');

    await page.locator('[data-action="reward-back"]').click();
    const bodyImage = page.locator('.shiguang-reward-tile img[data-badge-asset="body"]').first();
    await bodyImage.evaluate((image) => { image.src = 'data:image/png;base64,AAAA'; });
    await page.locator('.shiguang-reward-tile .shiguang-badge-fallback:not([hidden])').first().waitFor({ state: 'visible' });
    check('勋章资源失败时无破图并启用克制 fallback', (
      await bodyImage.isHidden()
      && await page.locator('.shiguang-reward-tile .shiguang-badge-fallback:not([hidden])').first().isVisible()
    ));
    await page.locator('.shiguang-reward-shelf').scrollIntoViewIfNeeded();
    await capture('badge-resource-fallback.png');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('减少动态效果模式仍可查看和操作收藏', (
      await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      && await page.locator('.shiguang-reward-shelf').isVisible()
    ));

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.locator('.shiguang-reward-shelf').scrollIntoViewIfNeeded();
      const metrics = await page.evaluate(() => {
        const panel = document.querySelector('.shiguang-panel')?.getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          panelRight: panel?.right || 0,
          panelBottom: panel?.bottom || 0,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      });
      check(`${viewport.label} 无横向滚动且收藏面板未越界`, (
        metrics.scrollWidth <= metrics.clientWidth + 2
        && metrics.panelRight <= viewport.width + 2
        && metrics.panelBottom <= viewport.height + 2
      ), metrics);
      await capture(`badge-collection-${viewport.label}.png`);
    }

    const normalChatVisible = await page.locator('[data-action="leave"]').isVisible();
    await page.locator('[data-action="leave"]').click();
    check('普通 AI 聊天在退出游戏后恢复', (
      normalChatVisible
      && await page.locator('#workspaceApp, #app').first().isVisible()
      && await page.locator('.shiguang-overlay').count() === 0
    ));
  } finally {
    await browser.close();
  }
}

check('浏览器无控制台错误', staticOnly || consoleErrors.length === 0, { consoleErrors });
check('浏览器无页面错误', staticOnly || pageErrors.length === 0, { pageErrors });
check('浏览器无 5xx', staticOnly || failedResponses.length === 0, { failedResponses });

const failed = checks.filter((item) => !item.passed);
const report = {
  status: failed.length ? 'FAIL' : 'PASS',
  mode: staticOnly ? 'static' : 'browser',
  generatedAt: new Date().toISOString(),
  rewardCatalogCount: 1,
  viewports,
  checks,
  failed: failed.map((item) => item.name),
  screenshots,
  consoleErrors,
  pageErrors,
  failedResponses,
  directionEvents,
  apiRecords,
  assetManifest,
};
await writeFile(path.join(output, 'acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  status: report.status,
  mode: report.mode,
  checks: checks.length,
  failed: failed.map((item) => item.name),
  screenshots: screenshots.length,
  output,
}, null, 2));
if (failed.length) process.exitCode = 1;
