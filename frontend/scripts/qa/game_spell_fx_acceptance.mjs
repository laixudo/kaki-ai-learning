/* global document, getComputedStyle, window */

import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const frontendRoot = path.join(projectRoot, 'frontend');
const publicRoot = path.join(frontendRoot, 'public', 'ai-workspace');
const spellRoot = path.join(publicRoot, 'assets', 'adventure', 'spells');
const registryPath = path.join(publicRoot, 'scripts', 'adventure-spell-registry.js');
const directorPath = path.join(publicRoot, 'scripts', 'adventure-spell-director.js');
const adventurePath = path.join(publicRoot, 'scripts', 'ai-workspace-adventure.js');
const htmlPath = path.join(publicRoot, 'ai-workspace-test.html');
const cssPath = path.join(publicRoot, 'styles', 'adventure-v2.css');
const kernelPath = path.join(frontendRoot, 'src', 'components', 'ai-learning', 'AiWorkspaceKernel.tsx');
const backendPath = path.join(projectRoot, 'backend', 'services', 'harvest_adventure.py');
const schemaPath = path.join(projectRoot, 'backend', 'schemas', 'harvest_adventure.py');
const frontendUrl = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const output = process.env.KAKI_SPELL_FX_EVIDENCE
  || path.join(projectRoot, 'evidence', 'game-spell-fx-20260730');
const staticOnly = process.argv.includes('--static-only');
const schools = [
  { id: 'fire', displayName: '炎咒', skill: '余焰' },
  { id: 'water', displayName: '水咒', skill: '清心' },
  { id: 'wind', displayName: '风咒', skill: '回风' },
  { id: 'wood', displayName: '木咒', skill: '生息' },
];
const assetKinds = ['emblem', 'charge', 'trail', 'impact_restore'];
const expectedAssetDimensions = {
  emblem: { width: 256, height: 256 },
  charge: { width: 512, height: 512 },
  trail: { width: 768, height: 256 },
  impact_restore: { width: 640, height: 640 },
};
const viewports = [
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1366, height: 768, label: '1366x768' },
];

const checks = [];
const screenshots = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const spellEvents = [];
const fallbackRecords = [];
const assetManifest = [];
const journeyRecords = [];

await mkdir(output, { recursive: true });

function check(name, passed, detail = {}) {
  checks.push({ name, passed: Boolean(passed), detail });
}

function pngMetadata(buffer) {
  const signature = buffer?.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a' || buffer.length < 26) return null;
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

const [registrySource, directorSource, adventureSource, htmlSource, cssSource, kernelSource, backendSource, schemaSource] = await Promise.all([
  readable(registryPath),
  readable(directorPath),
  readable(adventurePath),
  readable(htmlPath),
  readable(cssPath),
  readable(kernelPath),
  readable(backendPath),
  readable(schemaPath),
]);

check('后端法术真相保持为 fire water wind wood 四系', (
  /SCHOOLS\s*=\s*\{/.test(backendSource)
  && schools.every((school) => backendSource.includes(`"${school.id}"`) && backendSource.includes(`"${school.displayName}"`) && backendSource.includes(`"${school.skill}"`))
  && /Literal\["fire",\s*"water",\s*"wind",\s*"wood"\]/.test(schemaSource)
));
check('统一法术注册表存在', Boolean(registrySource));
check('统一法术导演存在', Boolean(directorSource));

for (const school of schools) {
  check(`${school.displayName} 进入统一注册表`, (
    registrySource.includes(`id: '${school.id}'`)
    && registrySource.includes(`displayName: '${school.displayName}'`)
  ));
  for (const field of [
    'emblem', 'selectionPreview', 'castOrigin', 'castAsset', 'trailAsset',
    'impactAsset', 'restoreAsset', 'accentClass', 'animationTiming',
    'bossScale', 'fallbackEffect',
  ]) {
    check(`${school.displayName} 注册 ${field}`, registrySource.includes(`${field}:`));
  }
  for (const kind of assetKinds) {
    const filename = `${school.id}_${kind}.png`;
    const absolute = path.join(spellRoot, filename);
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
      school: school.id,
      kind,
      filename,
      path: `/ai-workspace/assets/adventure/spells/${filename}`,
      exists: Boolean(info),
      bytes: info?.size || 0,
      width: metadata?.width || 0,
      height: metadata?.height || 0,
      format: 'PNG',
      transparent: Boolean(metadata?.transparent),
      source: 'OpenAI imagegen；本地色键抠除、去边与尺寸整理',
      sha256: buffer ? createHash('sha256').update(buffer).digest('hex') : '',
    });
    check(`${filename} 正式资源存在且非空`, Boolean(info && info.size > 8_000), {
      path: absolute,
      bytes: info?.size || 0,
    });
    check(`${filename} 尺寸和透明通道符合正式资源清单`, (
      metadata?.width === expectedAssetDimensions[kind].width
      && metadata?.height === expectedAssetDimensions[kind].height
      && metadata?.transparent === true
    ), metadata || {});
    check(`${school.displayName} 注册 ${filename}`, registrySource.includes(`spells/${filename}`));
  }
}

const sceneRegistryIndex = htmlSource.indexOf('adventure-scene-registry.js');
const spellRegistryIndex = htmlSource.indexOf('adventure-spell-registry.js');
const spellDirectorIndex = htmlSource.indexOf('adventure-spell-director.js');
const adventureIndex = htmlSource.indexOf('ai-workspace-adventure.js');
check('脚本按场景表 法术表 法术导演 主程序顺序加载', (
  sceneRegistryIndex >= 0
  && sceneRegistryIndex < spellRegistryIndex
  && spellRegistryIndex < spellDirectorIndex
  && spellDirectorIndex < adventureIndex
));
check('React 正式入口也按同样顺序挂载法术模块', (
  kernelSource.indexOf("'adventure-scene-registry.js'") < kernelSource.indexOf("'adventure-spell-registry.js'")
  && kernelSource.indexOf("'adventure-spell-registry.js'") < kernelSource.indexOf("'adventure-spell-director.js'")
  && kernelSource.indexOf("'adventure-spell-director.js'") < kernelSource.indexOf("'ai-workspace-adventure.js'")
  && kernelSource.includes("'KakiAdventureSpells'")
  && kernelSource.includes("'KakiAdventureSpellDirector'")
));

check('准备页从统一注册表渲染而非再次硬编码四系', (
  adventureSource.includes('KakiAdventureSpells')
  && !adventureSource.includes("['fire', 'water', 'wind', 'wood'].map")
));
check('法术选择具有预览与明确确认步骤', (
  adventureSource.includes('spell-selection-preview')
  && adventureSource.includes('data-action="confirm-school"')
  && adventureSource.includes('schoolConfirmed')
));
check('选择阶段只预加载徽记与当前预览', (
  registrySource.includes('preloadSelection')
  && registrySource.includes('selectionPreview')
  && adventureSource.includes('preloadSelection')
));
check('确认后只预加载当前法术完整演出资源', (
  registrySource.includes('preloadCast')
  && adventureSource.includes('preloadCast')
));
check('准备页仍只使用原 shiguang_manyou_prepare 暂存键', (
  adventureSource.includes("localStorage.getItem('shiguang_manyou_prepare')")
  && adventureSource.includes("localStorage.setItem('shiguang_manyou_prepare'")
  && !/localStorage\.(?:getItem|setItem)\('shiguang_manyou_spell/.test(adventureSource)
));
check('真实档案 magic_school 仍是旅程中的法术真相', (
  adventureSource.includes('archive.magic_school')
  && adventureSource.includes('archive.magic_school_name')
));

for (const phase of ['idle', 'previewing', 'charging', 'casting', 'travelling', 'impact', 'resolving', 'completed', 'cancelled']) {
  check(`统一导演声明 ${phase} 阶段`, directorSource.includes(`'${phase}'`));
}
check('统一导演发出可审计的 shiguang:spell 事件', directorSource.includes('shiguang:spell'));
check('统一导演支持 reduced-motion', (
  directorSource.includes('prefers-reduced-motion')
  && cssSource.includes('prefers-reduced-motion')
));
check('统一导演具备超时与取消清理', (
  directorSource.includes('setTimeout')
  && directorSource.includes('clearTimeout')
  && directorSource.includes('cancel')
));
check('正式资源失败时启用 CSS fallback', (
  directorSource.includes('fallbackEffect')
  && directorSource.includes('is-fallback')
  && directorSource.includes("type: 'asset-fallback'")
  && cssSource.includes('.shiguang-spell-fx.is-fallback')
));
check('真实 advance 返回后才触发施法演出', (
  /nextSnapshot\s*=\s*unwrap\(await api\.advanceHarvestAdventure/.test(adventureSource)
  && /await spellDirector\.playResult/.test(adventureSource)
  && adventureSource.indexOf('await spellDirector.playResult') > adventureSource.indexOf('await api.advanceHarvestAdventure')
));
check('复习结果只播放熄灭分支且保留答案', (
  directorSource.includes('needs_review')
  && directorSource.includes('fizzle')
  && adventureSource.includes('preservedAnswer')
));
check('Boss 最终成功使用增强倍率且先恢复场景后进入奖励', (
  directorSource.includes('bossScale')
  && adventureSource.includes('bossFinalSuccess')
  && adventureSource.includes('restored')
));
check('现有音频系统未被法术导演取代', (
  adventureSource.includes('audio.tone')
  && !directorSource.includes('AudioContext')
));
check('正式法术层具有固定安全层级且不覆盖底部面板', (
  cssSource.includes('.shiguang-spell-fx')
  && cssSource.includes('z-index: 19')
  && cssSource.includes('.shiguang-panel')
));

await writeFile(path.join(output, 'resource-manifest.json'), `${JSON.stringify(assetManifest, null, 2)}\n`, 'utf8');

if (!staticOnly) {
  const browser = await chromium.launch({ headless: true });

  async function registerAndLogin(context, page, label) {
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const username = `spell_fx_${label}_${stamp}`;
    const password = 'SpellFx!2026';
    const register = await context.request.post(`${frontendUrl}/api/auth/register`, {
      data: { username, password, email: `${username}@example.test` },
    });
    if (!register.ok()) throw new Error(`register returned ${register.status()}: ${await register.text()}`);
    const account = (await register.json()).data;
    const headers = { Authorization: `Bearer ${account.token}` };
    const onboarding = await context.request.post(`${frontendUrl}/api/profile-onboarding/start`, { headers });
    if (!onboarding.ok()) throw new Error(`onboarding start returned ${onboarding.status()}`);
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
    }, null, { timeout: 25_000 });
    if (await page.locator('.shiguang-dialogue').count()) await drainDialogue(page);
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      return overlay
        && !overlay.classList.contains('is-busy')
        && overlay.dataset.directionPhase === 'interactive'
        && !document.querySelector('.shiguang-dialogue');
    }, null, { timeout: 25_000 });
  }

  async function clickAndSettle(page, selector) {
    await page.locator(selector).click();
    await settle(page);
  }

  async function chooseDestination(page, id) {
    await page.locator(`[data-action="destination"][data-destination-id="${id}"]`).click();
    await settle(page);
  }

  async function chooseStay(page) {
    await page.locator('[data-action="destination"][data-destination-kind="stay"]').click();
    await settle(page);
  }

  async function capture(page, filename) {
    const absolute = path.join(output, filename);
    await page.screenshot({ path: absolute });
    screenshots.push(absolute);
    return absolute;
  }

  async function actionWithSpellCapture(page, action, label, expectedResult) {
    const startIndex = await page.evaluate(() => window.__kakiSpellEvents.length);
    await action();
    const expectedPhase = expectedResult === 'success' ? 'impact' : 'cancelled';
    await page.waitForFunction(
      (phase) => document.querySelector('.shiguang-spell-fx')?.dataset.spellPhase === phase,
      expectedPhase,
      { timeout: 10_000 },
    );
    await capture(page, `${label}-${expectedPhase}.png`);
    await settle(page);
    const events = await page.evaluate(
      (index) => window.__kakiSpellEvents.slice(index),
      startIndex,
    );
    const phases = events.filter((event) => event.type === 'phase').map((event) => event.phase);
    if (expectedResult === 'success') {
      check(`${label} 真实成功依次经过完整施法阶段`, (
        ['charging', 'casting', 'travelling', 'impact', 'resolving', 'completed']
          .every((phase) => phases.includes(phase))
      ), { phases });
    } else {
      check(`${label} 真实错误只蓄力后熄灭`, (
        phases.includes('charging')
        && phases.includes('cancelled')
        && !phases.includes('travelling')
        && !phases.includes('impact')
        && !phases.includes('resolving')
      ), { phases });
    }
    return { events, phases };
  }

  async function currentSnapshot(context, headers) {
    const response = await context.request.get(`${frontendUrl}/api/adventure/current`, { headers });
    if (!response.ok()) throw new Error(`current adventure returned ${response.status()}`);
    const body = await response.json();
    return body.data || body;
  }

  async function runSchoolJourney(school, viewport, fullJourney) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: school.id === 'wood' ? 'reduce' : 'no-preference',
    });
    const page = await context.newPage();
    const label = `${school.id}-${viewport.label}`;
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push({ journey: label, text: message.text() });
    });
    page.on('pageerror', (error) => pageErrors.push({ journey: label, message: error.message }));
    page.on('response', (response) => {
      if (response.status() >= 500) failedResponses.push({
        journey: label,
        status: response.status(),
        url: response.url(),
      });
    });
    await page.addInitScript(() => {
      window.__kakiSpellEvents = [];
      document.addEventListener('shiguang:spell', (event) => {
        window.__kakiSpellEvents.push({ ...event.detail, at: performance.now() });
      });
    });
    try {
      const account = await registerAndLogin(context, page, label);
      if (school.id === 'wood') {
        check('减少动态效果模式下进入真实木咒旅程', await page.evaluate(
          () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        ));
      }
      await page.locator('#adventureEntry').click();
      await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
      await page.locator('#shiguangTopic').fill('机器学习模型评估');
      await page.locator('input[name="source"][value="manual"]').check();
      const startButton = page.locator('[data-action="start"]');
      check(`${label} 未确认前不能开始`, await startButton.isDisabled());
      await page.locator(`.shiguang-schools label[data-school="${school.id}"]`).click();
      const ritualMetrics = await page.evaluate((schoolId) => ({
        emblemCount: document.querySelectorAll('.shiguang-schools img').length,
        selected: document.querySelector('input[name="school"]:checked')?.value,
        preview: document.querySelector('.spell-selection-preview')?.dataset.previewSchool,
        previewLinks: [...document.querySelectorAll('link[data-spell-preload$="selectionPreview"]')]
          .map((link) => link.dataset.spellSchool),
      }), school.id);
      check(`${label} 仪式显示四枚正式徽记和当前预览`, (
        ritualMetrics.emblemCount === 4
        && ritualMetrics.selected === school.id
        && ritualMetrics.preview === school.id
        && ritualMetrics.previewLinks.includes(school.id)
      ), ritualMetrics);
      if (fullJourney) {
        const fallbackEventStart = await page.evaluate(() => window.__kakiSpellEvents.length);
        await page.locator('.shiguang-spell-fx img').first().evaluate((image) => {
          image.src = 'data:image/png;base64,AAAA';
        });
        await page.locator('.shiguang-spell-fx.is-fallback').waitFor({ state: 'visible' });
        const fallbackAudit = await page.evaluate((index) => ({
          fallbackClass: Boolean(document.querySelector('.shiguang-spell-fx.is-fallback')),
          fallbackEffect: document.querySelector('.shiguang-spell-fx')?.dataset.fallbackEffect || '',
          events: window.__kakiSpellEvents.slice(index).filter((event) => event.type === 'asset-fallback'),
        }), fallbackEventStart);
        check('主动破坏预览资源后真实启用 CSS fallback 并发出审计事件', (
          fallbackAudit.fallbackClass
          && Boolean(fallbackAudit.fallbackEffect)
          && fallbackAudit.events.length === 1
          && fallbackAudit.events[0].school === school.id
        ), fallbackAudit);
        fallbackRecords.push({ journey: label, ...fallbackAudit });
        await page.locator('.shiguang-schools label[data-school="water"]').hover();
        await page.locator(`.shiguang-schools label[data-school="${school.id}"]`).hover();
        await page.waitForFunction(
          (schoolId) => document.querySelector('.spell-selection-preview')?.dataset.previewSchool === schoolId
            && !document.querySelector('.shiguang-spell-fx.is-fallback'),
          school.id,
        );
      }
      await page.locator('.shiguang-panel').evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await page.locator(`.shiguang-schools label[data-school="${school.id}"]`).hover();
      await capture(page, `${label}-selection-ritual.png`);
      await page.locator('[data-action="confirm-school"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-action="confirm-school"]')?.textContent.includes('已确认'),
        null,
        { timeout: 5_000 },
      );
      check(`${label} 明确确认后才允许开始`, !(await startButton.isDisabled()));
      const castPreloads = await page.evaluate((schoolId) => ({
        selected: [...document.querySelectorAll(`link[data-spell-school="${schoolId}"]`)]
          .map((link) => link.dataset.spellPreload),
        otherCast: [...document.querySelectorAll('link[data-spell-preload*="Asset"]')]
          .filter((link) => link.dataset.spellSchool !== schoolId)
          .map((link) => link.dataset.spellPreload),
      }), school.id);
      check(`${label} 确认后只预加载当前法术演出资源`, (
        castPreloads.selected.some((key) => key.endsWith(':castAsset'))
        && castPreloads.selected.some((key) => key.endsWith(':trailAsset'))
        && castPreloads.selected.some((key) => key.endsWith(':impactAsset'))
        && castPreloads.selected.some((key) => key.endsWith(':restoreAsset'))
        && castPreloads.otherCast.length === 0
      ), castPreloads);
      const [startResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().includes('/api/adventure/start')),
        startButton.click(),
      ]);
      check(`${label} 通过真实 start API 开始旅程`, startResponse.status() === 200, {
        status: startResponse.status(),
      });
      await settle(page);
      const started = await currentSnapshot(context, account.headers);
      check(`${label} 后端档案保存当前法术真相`, (
        started.archive.magic_school === school.id
        && started.archive.magic_school_name === school.displayName
      ), started.archive);
      check(`${label} HUD 显示当前法术徽记`, await page.locator(`.shiguang-active-spell[data-active-school="${school.id}"] img`).isVisible());
      if (fullJourney) {
        await page.locator('[data-action="leave"]').click();
        await page.locator('.shiguang-overlay').waitFor({ state: 'detached' });
        await page.locator('#adventureEntry').click();
        await settle(page);
        check('退出重进恢复同一真实法术且不重复施放', (
          await page.locator(`.shiguang-active-spell[data-active-school="${school.id}"] img`).isVisible()
          && await page.locator('.shiguang-spell-fx').count() === 0
        ));
        await page.locator('[data-action="leave"]').click();
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('#adventureEntry').click();
        await settle(page);
        check('页面刷新后恢复同一真实法术且不重复施放', (
          await page.locator(`.shiguang-active-spell[data-active-school="${school.id}"] img`).isVisible()
          && await page.locator('.shiguang-spell-fx').count() === 0
        ));
      }

      await chooseDestination(page, 'echo_archive');
      await clickAndSettle(page, '[data-action="continue"]');
      await chooseStay(page);
      await clickAndSettle(page, '[data-action="continue"]');
      await chooseStay(page);
      await clickAndSettle(page, '[data-action="method"][data-method="explain"]');
      await chooseStay(page);

      let primarySpell;
      if (fullJourney) {
        await page.locator('.shiguang-answer textarea').fill('不知道');
        const beforeWrong = await page.locator('.shiguang-answer textarea').inputValue();
        const wrong = await actionWithSpellCapture(
          page,
          () => page.locator('.shiguang-answer [type="submit"]').click(),
          `${school.id}-trial-needs-review`,
          'needs_review',
        );
        const afterWrong = await page.locator('.shiguang-answer textarea').count()
          ? await page.locator('.shiguang-answer textarea').inputValue()
          : beforeWrong;
        check('错误结果演出期间保留原作答证据', beforeWrong === '不知道' && afterWrong === beforeWrong, {
          beforeWrong,
          afterWrong,
          phases: wrong.phases,
        });
        await chooseStay(page);
        primarySpell = await actionWithSpellCapture(
          page,
          () => page.locator('.shiguang-options [data-action="answer"]').first().click(),
          `${school.id}-remedy-success`,
          'success',
        );
      } else {
        await page.locator('.shiguang-answer textarea').fill('模型需要在未见新数据上检验泛化，避免过拟合');
        primarySpell = await actionWithSpellCapture(
          page,
          () => page.locator('.shiguang-answer [type="submit"]').click(),
          `${school.id}-trial-success`,
          'success',
        );
      }
      check(`${label} 演出事件携带当前法术`, primarySpell.events.some((event) => event.school === school.id), {
        events: primarySpell.events,
      });

      if (fullJourney) {
        await chooseStay(page);
        await actionWithSpellCapture(
          page,
          () => page.locator('.shiguang-options [data-action="answer"]').first().click(),
          `${school.id}-interleave-success`,
          'success',
        );
        await chooseStay(page);
        await page.locator('.shiguang-answer textarea').fill('泛化能力是模型在未见新数据上的预测表现');
        await actionWithSpellCapture(
          page,
          () => page.locator('.shiguang-answer [type="submit"]').click(),
          `${school.id}-boss-stage-one`,
          'success',
        );
        await chooseStay(page);
        await actionWithSpellCapture(
          page,
          () => page.locator('.shiguang-options [data-action="answer"]').first().click(),
          `${school.id}-boss-stage-two`,
          'success',
        );
        await chooseStay(page);
        await page.locator('.shiguang-answer textarea').fill('这是过拟合，我会使用早停改善泛化');
        const bossStart = await page.evaluate(() => window.__kakiSpellEvents.length);
        await page.locator('.shiguang-answer [type="submit"]').click();
        await page.waitForFunction(
          () => document.querySelector('.shiguang-spell-fx')?.dataset.spellPhase === 'impact',
          null,
          { timeout: 10_000 },
        );
        await capture(page, `${school.id}-boss-final-impact.png`);
        await page.waitForFunction(
          () => document.querySelector('.shiguang-scene')?.dataset.sceneState === 'boss_restored',
          null,
          { timeout: 15_000 },
        );
        await capture(page, `${school.id}-boss-restored.png`);
        await settle(page);
        const bossEvents = await page.evaluate((index) => window.__kakiSpellEvents.slice(index), bossStart);
        check('Boss 最终成功沿用当前法术且启用增强倍率', (
          bossEvents.some((event) => event.phase === 'impact' && event.school === school.id && event.bossFinal === true)
        ), { bossEvents });
        check('Boss 最终成功先显示平静修复场景再进入宝库', await page.locator('[data-action="destination"]').first().isVisible());
        await chooseStay(page);
        check('宝库奖励仍由玩家主动领取', await page.locator('[data-action="claim"]').isVisible());
        await clickAndSettle(page, '[data-action="claim"]');
        check('原有完成与烟火流程仍可抵达', (
          await page.locator('.shiguang-celebration-bursts i').count() === 3
          && await page.locator('[data-action="return"]').isVisible()
        ));
      }

      const layout = await page.evaluate(() => {
        const stage = document.querySelector('.shiguang-stage')?.getBoundingClientRect();
        const panel = document.querySelector('.shiguang-panel')?.getBoundingClientRect();
        const head = document.querySelector('.shiguang-head')?.getBoundingClientRect();
        return {
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          headHeight: head?.height || 0,
          panelInsideViewport: Boolean(panel && panel.left >= 0 && panel.right <= window.innerWidth && panel.bottom <= window.innerHeight),
          stageHeight: stage?.height || 0,
        };
      });
      check(`${label} 舞台布局在目标尺寸内稳定`, (
        !layout.horizontalOverflow
        && Math.abs(layout.headHeight - 62) < 2
        && layout.panelInsideViewport
        && layout.stageHeight > 500
      ), layout);
      const events = await page.evaluate(() => window.__kakiSpellEvents);
      spellEvents.push(...events.map((event) => ({ journey: label, ...event })));
      journeyRecords.push({
        journey: label,
        username: account.username,
        school: school.id,
        viewport,
        fullJourney,
        layout,
        eventCount: events.length,
      });
    } finally {
      await context.close();
    }
  }

  try {
    await runSchoolJourney(schools[0], viewports[0], true);
    await runSchoolJourney(schools[1], viewports[1], false);
    await runSchoolJourney(schools[2], viewports[2], false);
    await runSchoolJourney(schools[3], viewports[0], false);
  } finally {
    await browser.close();
  }
}

check('浏览器无控制台错误', staticOnly || consoleErrors.length === 0, { consoleErrors });
check('浏览器无页面错误', staticOnly || pageErrors.length === 0, { pageErrors });
check('浏览器无 5xx 响应', staticOnly || failedResponses.length === 0, { failedResponses });

const failed = checks.filter((item) => !item.passed);
const report = {
  status: failed.length ? 'FAIL' : 'PASS',
  mode: staticOnly ? 'static' : 'browser',
  generatedAt: new Date().toISOString(),
  checks: checks.length,
  failed: failed.map((item) => item.name),
  viewports,
  screenshots,
  spellEvents,
  fallbackRecords,
  journeys: journeyRecords,
  diagnostics: { consoleErrors, pageErrors, failedResponses },
};
await writeFile(path.join(output, 'acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;
