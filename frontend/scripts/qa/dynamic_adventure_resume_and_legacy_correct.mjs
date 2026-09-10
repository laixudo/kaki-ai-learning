import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:8765';
const output = process.env.KAKI_EVIDENCE || path.resolve('evidence/dynamic-adventure-10-browser-closeout-20260801');
const formalUrl = `${base}/ai-workspace-test.html?v=standalone-score-fix-20260714`;
const failedRun = JSON.parse(await readFile(path.join(output, 'browser-closeout-report.json'), 'utf8'));
const username = failedRun.user.username;
const password = 'Dynamic10!2026';
const checks = [];
const consoleErrors = [];
const pageErrors = [];
const networkErrors = [];
const screenshots = [];
const dialogue = {};

function check(name, condition, details = null) {
  checks.push({ name, pass: Boolean(condition), details });
  if (!condition) throw new Error(`${name}: ${JSON.stringify(details)}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
check('resume user login succeeds', login.ok(), { status: login.status() });
const auth = (await login.json()).data;
const headers = { Authorization: `Bearer ${auth.token}` };
await context.addInitScript(({ token, user }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: auth.token, user: { userId: auth.user_id, username, email: auth.email, avatarUrl: null, hasProfile: true } });

const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => networkErrors.push({ kind: 'requestfailed', url: request.url(), error: request.failure()?.errorText || '' }));
page.on('response', (response) => { if (response.status() >= 400) networkErrors.push({ kind: 'http', status: response.status(), url: response.url() }); });

async function current() {
  const response = await context.request.get(`${base}/api/adventure/current`, { headers });
  check('current endpoint succeeds', response.ok(), { status: response.status() });
  return (await response.json()).data;
}

async function shot(name) {
  const target = path.join(output, name);
  await page.waitForTimeout(200);
  await page.screenshot({ path: target, fullPage: true });
  screenshots.push(target);
}

async function waitState(expected) {
  await page.waitForFunction((value) => document.querySelector('.shiguang-overlay')?.dataset.state === value, expected, { timeout: 60_000 });
}

async function drain(label) {
  const lines = [];
  for (let turn = 0; turn < 48; turn += 1) {
    const node = page.locator('.shiguang-dialogue');
    if (!await node.count()) break;
    const before = await node.evaluate((element) => ({ index: Number(element.dataset.queueIndex || 0), complete: element.dataset.lineComplete === 'true' }));
    if (!before.complete) {
      await node.locator('[data-action="dialogue-next"]').click();
      await page.waitForFunction(({ index }) => {
        const currentNode = document.querySelector('.shiguang-dialogue');
        return !currentNode || (Number(currentNode.dataset.queueIndex || 0) === index && currentNode.dataset.lineComplete === 'true');
      }, before, { timeout: 10_000 });
    }
    if (await node.count()) {
      lines.push(await node.evaluate((element) => ({
        speaker: element.querySelector('.shiguang-dialogue-speaker small')?.textContent?.trim() || '',
        text: element.querySelector('[data-dialogue-text]')?.textContent?.trim() || '',
      })));
      await node.locator('[data-action="dialogue-next"]').click();
      await page.waitForFunction(({ index }) => {
        const currentNode = document.querySelector('.shiguang-dialogue');
        return !currentNode || Number(currentNode.dataset.queueIndex || 0) > index;
      }, before, { timeout: 10_000 });
    }
  }
  dialogue[label] = [...(dialogue[label] || []), ...lines];
}

async function settle(label) {
  await page.waitForFunction(() => {
    const overlay = document.querySelector('.shiguang-overlay');
    return overlay && !overlay.classList.contains('is-busy') && ['dialogue', 'interactive'].includes(overlay.dataset.directionPhase || '');
  }, null, { timeout: 60_000 });
  if (await page.locator('.shiguang-dialogue').count()) await drain(label);
  await page.waitForFunction(() => {
    const overlay = document.querySelector('.shiguang-overlay');
    return overlay && !overlay.classList.contains('is-busy') && overlay.dataset.directionPhase === 'interactive' && !document.querySelector('.shiguang-dialogue');
  }, null, { timeout: 60_000 });
}

async function enter(label, preferred = '') {
  await settle(label);
  if (!await page.locator('.shiguang-destination-choice').count()) return;
  let destination = preferred ? page.locator(`[data-action="destination"][data-destination-id="${preferred}"]`) : page.locator('[data-action="destination"][data-destination-kind="stay"]');
  if (!await destination.count()) destination = page.locator('[data-action="destination"][data-destination-kind="travel"]').first();
  await destination.click();
  await settle(label);
}

async function action(name) {
  await page.locator(`[data-action="${name}"]`).evaluate((button) => button.click());
}

async function submit(text) {
  await page.locator('.shiguang-answer textarea').fill(text);
  await page.locator('.shiguang-answer').evaluate((form) => form.requestSubmit());
}

async function routeState(runId) {
  return page.evaluate((id) => {
    const key = Object.keys(localStorage).find((item) => item.startsWith('kaki_adventure_route_v1:') && item.endsWith(`:${encodeURIComponent(id)}`));
    return {
      key: key || '', raw: key ? localStorage.getItem(key) : null,
      scene: document.querySelector('.shiguang-overlay')?.dataset.sceneId || '',
      state: document.querySelector('.shiguang-overlay')?.dataset.state || '',
    };
  }, runId);
}

try {
  await page.goto(formalUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#adventureEntry').waitFor({ state: 'visible' });
  await page.locator('#adventureEntry').click();
  const dynamicRun = await current();
  check('real dynamic run resumes with its frozen narrative', Boolean(dynamicRun.narrative), { run_id: dynamicRun.run_id, state: dynamicRun.state, boss_stage: dynamicRun.archive.boss_stage });
  if (dynamicRun.state === 'SUPPLY') {
    check('real dynamic run resumes at remedial SUPPLY', dynamicRun.archive.remedial_required === true, {
      run_id: dynamicRun.run_id, state: dynamicRun.state, remedial_required: dynamicRun.archive.remedial_required,
    });
    await enter('DYNAMIC-SUPPLY');
    check('dynamic remedial SUPPLY visibly uses supply_remediation state_copy',
      (dialogue['DYNAMIC-SUPPLY'] || []).some((line) => line.text === dynamicRun.narrative.state_copy.supply_remediation),
      dialogue['DYNAMIC-SUPPLY']);
    await shot('13-dynamic-supply-remediation.png');
    await submit('P(B)=P(B|A)*P(A)+P(B|非A)*P(非A)，也就是P(B|A)P(A)+P(B|非A)P(非A)。');
    await waitState('interleave');
    const afterRemedy = await current();
    check('Planner remedy returns the dynamic run to INTERLEAVE', afterRemedy.state === 'INTERLEAVE' && afterRemedy.archive.remedial_required === false, {
      state: afterRemedy.state, remedial_required: afterRemedy.archive.remedial_required, feedback: afterRemedy.feedback,
    });
  }
  let dynamicBoss = await current();
  if (dynamicBoss.state === 'INTERLEAVE') {
    await enter('DYNAMIC-INTERLEAVE');
    await page.locator('[data-action="answer"]').first().click();
    await waitState('boss');
    dynamicBoss = await current();
  }
  check('dynamic run reaches Boss for continuation', dynamicBoss.state === 'BOSS', { state: dynamicBoss.state, boss_stage: dynamicBoss.archive.boss_stage });
  if (dynamicBoss.archive.boss_stage === 0) {
    await enter('DYNAMIC-BOSS-0');
    await submit('因为先验概率低、基础比率低，同时存在假阳性，所以检测阳性后的患病概率仍可能很低。');
    await enter('DYNAMIC-BOSS-1');
    dynamicBoss = await current();
    check('dynamic Boss explanation stage passes', dynamicBoss.archive.boss_stage === 1, { boss_stage: dynamicBoss.archive.boss_stage });
  }
  if (dynamicBoss.archive.boss_stage === 1) {
    await page.locator('[data-action="answer"]').nth(2).click();
    await enter('DYNAMIC-BOSS-2');
    dynamicBoss = await current();
  }
  check('dynamic Boss distinction stage passes', dynamicBoss.archive.boss_stage === 2, { boss_stage: dynamicBoss.archive.boss_stage });

  const beforeRefresh = { snapshot: dynamicBoss, route: await routeState(dynamicBoss.run_id) };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#adventureEntry').waitFor({ state: 'visible' });
  await page.locator('#adventureEntry').click();
  await waitState('boss');
  await settle('DYNAMIC-BOSS-2-RESTORE');
  const afterRefresh = { snapshot: await current(), route: await routeState(dynamicBoss.run_id) };
  check('refresh restores frozen dynamic narrative, route, station and Boss stage',
    afterRefresh.snapshot.run_id === beforeRefresh.snapshot.run_id
      && JSON.stringify(afterRefresh.snapshot.narrative) === JSON.stringify(beforeRefresh.snapshot.narrative)
      && afterRefresh.snapshot.archive.boss_stage === 2
      && afterRefresh.route.raw === beforeRefresh.route.raw
      && afterRefresh.route.scene === beforeRefresh.route.scene
      && afterRefresh.route.state === beforeRefresh.route.state,
    { before: { run_id: beforeRefresh.snapshot.run_id, boss_stage: beforeRefresh.snapshot.archive.boss_stage, route: beforeRefresh.route }, after: { run_id: afterRefresh.snapshot.run_id, boss_stage: afterRefresh.snapshot.archive.boss_stage, route: afterRefresh.route } });
  await shot('14-dynamic-refresh-restored.png');

  await submit('P(猫|判断猫)=0.9*0.1/(0.9*0.1+0.05*0.9)=0.09/(0.09+0.045)=0.667≈66.7%。');
  await waitState('treasury');
  await settle('DYNAMIC-TREASURY');
  check('dynamic TREASURY visibly uses resolution state_copy',
    (dialogue['DYNAMIC-TREASURY'] || []).some((line) => line.text === dynamicRun.narrative.state_copy.resolution),
    dialogue['DYNAMIC-TREASURY']);
  const dynamicClaimResponse = page.waitForResponse((response) => response.url().includes('/api/adventure/advance') && response.request().method() === 'POST');
  await action('reward-collect');
  const dynamicClaim = (await (await dynamicClaimResponse).json()).data;
  await waitState('completed');
  await settle('DYNAMIC-COMPLETED');
  check('dynamic wrong-path recovery completes at completed', dynamicClaim.state === 'completed' && Boolean(dynamicClaim.artifact_id), { state: dynamicClaim.state, artifact_id: dynamicClaim.artifact_id });
  await shot('15-dynamic-completed.png');

  const legacyStartResponse = await context.request.post(`${base}/api/adventure/start`, {
    headers,
    data: { topic: '机器学习模型评估', magic_school: 'wood', source_ids: [], source_type: 'manual', force_new: true, prepared_plan_id: null },
  });
  check('legacy direct start succeeds', legacyStartResponse.ok(), { status: legacyStartResponse.status() });
  const legacyStart = (await legacyStartResponse.json()).data;
  check('legacy direct start has narrative null', legacyStart.narrative === null, { run_id: legacyStart.run_id, narrative: legacyStart.narrative });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#adventureEntry').waitFor({ state: 'visible' });
  await page.locator('#adventureEntry').click();
  await waitState('goal');
  await settle('LEGACY-GOAL');
  const fallbackDestinations = await page.locator('[data-action="destination"][data-destination-kind="travel"]').evaluateAll((nodes) => nodes.map((node) => ({ id: node.dataset.destinationId, registered: Boolean(window.KakiAdventureSceneRegistry?.has(node.dataset.destinationId)) })));
  check('legacy static fallback exposes usable registered destinations', fallbackDestinations.length >= 2 && fallbackDestinations.every((item) => item.registered), fallbackDestinations);
  await enter('LEGACY-GOAL', fallbackDestinations[0].id);
  await action('continue'); await waitState('scroll'); await enter('LEGACY-SCROLL');
  await action('continue'); await waitState('method'); await enter('LEGACY-METHOD');
  await page.locator('[data-action="method"][data-method="practice"]').click(); await waitState('trial'); await enter('LEGACY-TRIAL');
  await page.locator('[data-action="answer"]').first().click(); await waitState('supply');
  const ordinarySupply = await current();
  check('legacy correct TRIAL reaches ordinary SUPPLY', ordinarySupply.archive.remedial_required === false, { state: ordinarySupply.state, remedial_required: ordinarySupply.archive.remedial_required });
  await enter('LEGACY-SUPPLY'); await shot('16-legacy-correct-supply.png');
  await action('continue'); await waitState('interleave'); await enter('LEGACY-INTERLEAVE');
  await submit('我会使用正则化或早停来减少过拟合并改善泛化。'); await waitState('boss'); await enter('LEGACY-BOSS-0');
  await submit('泛化能力是模型在未见新数据上的预测表现。'); await enter('LEGACY-BOSS-1');
  let legacyBoss = await current(); check('legacy correct Boss explanation stage passes', legacyBoss.archive.boss_stage === 1, { boss_stage: legacyBoss.archive.boss_stage });
  await page.locator('[data-action="answer"]').first().click(); await enter('LEGACY-BOSS-2');
  legacyBoss = await current(); check('legacy correct Boss distinction stage passes', legacyBoss.archive.boss_stage === 2, { boss_stage: legacyBoss.archive.boss_stage });
  await submit('这是过拟合，我会使用早停来改善泛化。'); await waitState('treasury'); await settle('LEGACY-TREASURY');
  const legacyClaimResponse = page.waitForResponse((response) => response.url().includes('/api/adventure/advance') && response.request().method() === 'POST');
  await action('reward-collect');
  const legacyClaim = (await (await legacyClaimResponse).json()).data;
  await waitState('completed'); await settle('LEGACY-COMPLETED');
  check('legacy correct full browser route reaches completed', legacyClaim.state === 'completed' && Boolean(legacyClaim.artifact_id), { state: legacyClaim.state, artifact_id: legacyClaim.artifact_id });
  await shot('17-legacy-correct-completed.png');

  check('browser console has no errors', consoleErrors.length === 0, consoleErrors);
  check('browser page has no errors', pageErrors.length === 0, pageErrors);
  check('browser network has no 4xx/5xx or failed requests', networkErrors.length === 0, networkErrors);
} catch (error) {
  checks.push({ name: 'unhandled resume closeout error', pass: false, details: error.stack || error.message });
  try { await shot('98-resume-failure.png'); } catch (_) {}
}

const report = {
  status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL',
  formal_url: formalUrl,
  resumed_user: username,
  checks,
  dialogue,
  console_errors: consoleErrors,
  page_errors: pageErrors,
  network_errors: networkErrors,
  screenshots,
};
await writeFile(path.join(output, 'browser-resume-and-correct-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exitCode = report.status === 'PASS' ? 0 : 1;
