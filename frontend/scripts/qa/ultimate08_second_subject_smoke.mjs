import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
const output = process.env.KAKI_EVIDENCE || path.resolve('../evidence/08/adventure-second-subject');
const username = `photo08_${Date.now()}`;
const password = 'Photo08!2026';
const email = `${username}@example.test`;
const checks = [];
const dialogue = {};
const errors = [];

await mkdir(output, { recursive: true });
function check(name, condition, details = null) {
  checks.push({ name, pass: Boolean(condition), details });
  if (!condition) throw new Error(`${name}: ${JSON.stringify(details)}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
let registered;
try {
  const register = await context.request.post(`${base}/api/auth/register`, { data: { username, password, email } });
  check('photography smoke user registers', register.ok(), { status: register.status() });
  registered = (await register.json()).data;
  const headers = { Authorization: `Bearer ${registered.token}` };
  const onboarding = await context.request.post(`${base}/api/profile-onboarding/start`, { headers });
  check('photography smoke onboarding starts', onboarding.ok(), { status: onboarding.status() });
  const taskId = (await onboarding.json()).data.task_id;
  const skip = await context.request.post(`${base}/api/profile-onboarding/skip`, { headers, data: { task_id: taskId } });
  check('photography smoke onboarding completes', skip.ok(), { status: skip.status() });

  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('auth_token', token);
    localStorage.setItem('ml_auth_token', token);
    localStorage.setItem('kaki_user', JSON.stringify(user));
    localStorage.setItem('ml_current_user_id', String(user.userId));
    localStorage.setItem('kaki_profile_status', 'complete');
  }, { token: registered.token, user: { userId: registered.user_id, username, email, avatarUrl: null, hasProfile: true } });

  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on('console', (message) => { if (message.type() === 'error') errors.push({ type: 'console', text: message.text() }); });
  page.on('pageerror', (error) => errors.push({ type: 'pageerror', text: error.message }));

  async function drain(label) {
    const lines = [];
    for (let turn = 0; turn < 48; turn += 1) {
      const node = page.locator('.shiguang-dialogue');
      if (!(await node.count())) break;
      const before = await node.evaluate((element) => ({ index: Number(element.dataset.queueIndex || 0), complete: element.dataset.lineComplete === 'true' }));
      if (!before.complete) {
        await node.locator('[data-action="dialogue-next"]').click();
        await page.waitForFunction(({ index }) => {
          const current = document.querySelector('.shiguang-dialogue');
          return !current || (Number(current.dataset.queueIndex || 0) === index && current.dataset.lineComplete === 'true');
        }, before);
      }
      if (await node.count()) {
        lines.push(await node.evaluate((element) => ({
          speaker: element.querySelector('.shiguang-dialogue-speaker small')?.textContent?.trim() || '',
          text: element.querySelector('[data-dialogue-text]')?.textContent?.trim() || '',
        })));
        await node.locator('[data-action="dialogue-next"]').click();
        await page.waitForFunction(({ index }) => {
          const current = document.querySelector('.shiguang-dialogue');
          return !current || Number(current.dataset.queueIndex || 0) > index;
        }, before);
      }
    }
    dialogue[label] = [...(dialogue[label] || []), ...lines];
  }

  async function settle(label) {
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      return overlay && !overlay.classList.contains('is-busy') && ['dialogue', 'interactive'].includes(overlay.dataset.directionPhase || '');
    });
    if (await page.locator('.shiguang-dialogue').count()) await drain(label);
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      return overlay && !overlay.classList.contains('is-busy') && overlay.dataset.directionPhase === 'interactive' && !document.querySelector('.shiguang-dialogue');
    });
  }

  async function chooseLocation(label) {
    await settle(label);
    const choices = page.locator('[data-action="destination"]');
    if (await choices.count()) {
      const choice = page.locator('[data-action="destination"][data-destination-kind="travel"]').first();
      await choice.click();
      await settle(label);
    }
  }

  await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
  const workspace = page;
  await workspace.locator('#input').waitFor({ state: 'visible' });
  const assistantCount = await workspace.locator('#messages .msg.assistant').count();
  await workspace.locator('#input').fill('我在学人像摄影：光圈、快门速度和 ISO 怎样共同决定曝光？环境变暗时怎么选择而不把人拍糊？');
  await workspace.locator('#send').click();
  await workspace.waitForFunction((count) => document.querySelectorAll('#messages .msg.assistant').length > count && !document.querySelector('#send')?.disabled, assistantCount, { timeout: 120_000 });
  check('photography question is sent through visible Tutor controls', true);

  const preparePromise = workspace.waitForResponse((response) => response.url().includes('/api/adventure/prepare') && response.request().method() === 'POST', { timeout: 240_000 });
  await workspace.locator('#adventureEntry').click();
  const prepare = await preparePromise;
  check('photography Adventure prepare succeeds', prepare.ok(), { status: prepare.status() });
  const prepared = (await prepare.json()).data;
  const preparedText = JSON.stringify(prepared.narrative || {});
  check('prepared world is grounded in photography', /摄影|光圈|快门|曝光|ISO|景深/.test(preparedText), prepared.narrative);
  check('prepared world is not hard-coded to machine learning', !/机器学习|梯度下降|神经网络|模型训练/.test(preparedText), prepared.narrative);
  await workspace.locator('#adventurePrepare:not([hidden])').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, '01-photography-prepare.png'), fullPage: true });

  const startPromise = workspace.waitForResponse((response) => response.url().includes('/api/adventure/start') && response.request().method() === 'POST');
  await workspace.locator('#adventurePrepareStart').click();
  const start = await startPromise;
  check('photography prepared run starts', start.ok(), { status: start.status() });
  const snapshot = (await start.json()).data;
  await workspace.locator('.shiguang-overlay').waitFor({ state: 'visible' });

  const active = workspace;
  async function frameDrain(label) {
    const lines = [];
    for (let turn = 0; turn < 48; turn += 1) {
      const node = active.locator('.shiguang-dialogue');
      if (!(await node.count())) break;
      const before = await node.evaluate((element) => ({ index: Number(element.dataset.queueIndex || 0), complete: element.dataset.lineComplete === 'true' }));
      if (!before.complete) {
        await node.locator('[data-action="dialogue-next"]').click();
        await active.waitForFunction(({ index }) => {
          const current = document.querySelector('.shiguang-dialogue');
          return !current || (Number(current.dataset.queueIndex || 0) === index && current.dataset.lineComplete === 'true');
        }, before);
      }
      if (await node.count()) {
        lines.push({ speaker: (await node.locator('.shiguang-dialogue-speaker small').textContent())?.trim() || '', text: (await node.locator('[data-dialogue-text]').textContent())?.trim() || '' });
        await node.locator('[data-action="dialogue-next"]').click();
        await active.waitForFunction(({ index }) => !document.querySelector('.shiguang-dialogue') || Number(document.querySelector('.shiguang-dialogue')?.dataset.queueIndex || 0) > index, before);
      }
    }
    dialogue[label] = [...(dialogue[label] || []), ...lines];
  }
  async function frameSettle(label) {
    await active.waitForFunction(() => {
      const overlay = document.querySelector('.shiguang-overlay');
      const phase = overlay?.dataset.directionPhase || '';
      return overlay && !overlay.classList.contains('is-busy') && (phase === 'dialogue' || phase === 'interactive');
    });
    if (await active.locator('.shiguang-dialogue').count()) await frameDrain(label);
    await active.waitForFunction(() => document.querySelector('.shiguang-overlay')?.dataset.directionPhase === 'interactive' && !document.querySelector('.shiguang-dialogue'));
  }
  async function frameChoose(label) {
    await frameSettle(label);
    const labels = await active.locator('[data-action="destination"]').allTextContents();
    const travel = active.locator('[data-action="destination"][data-destination-kind="travel"]').first();
    if (await travel.count()) { await travel.click(); await frameSettle(label); }
    return labels;
  }

  const destinationText = await frameChoose('GOAL');
  check('photography run exposes a real location decision', destinationText.length >= 2, destinationText);
  await page.screenshot({ path: path.join(output, '02-photography-world-location.png'), fullPage: true });
  await active.locator('[data-action="continue"]').click();
  await frameChoose('SCROLL');
  await active.locator('[data-action="continue"]').click();
  await frameChoose('METHOD');
  await active.locator('[data-action="method"][data-method="practice"]').click();
  await frameChoose('TRIAL');
  const trialText = await active.locator('.shiguang-panel').innerText();
  const enemyMeaning = await active.locator('[data-enemy-root]').getAttribute('data-misconception');
  const combined = `${preparedText} ${JSON.stringify(dialogue)} ${trialText} ${enemyMeaning || ''}`;
  check('photography dialogue and question remain topic-grounded', /摄影|光圈|快门|曝光|ISO|景深/.test(combined), { dialogue, trialText, enemyMeaning });
  check('photography enemy meaning is not machine-learning residue', !/机器学习|梯度下降|神经网络|模型训练/.test(`${trialText} ${enemyMeaning || ''}`), { trialText, enemyMeaning });
  check('photography trial is actually operable', await active.locator('[data-action="answer"], .shiguang-answer textarea').count() > 0);
  await page.screenshot({ path: path.join(output, '03-photography-trial-enemy.png'), fullPage: true });
  check('photography smoke has no browser errors', errors.length === 0, errors);
} catch (error) {
  checks.push({ name: 'unhandled photography smoke error', pass: false, details: error.stack || error.message });
}

const report = { status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL', user_id: registered?.user_id || null, checks, dialogue, errors };
await writeFile(path.join(output, 'second-subject-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (report.status !== 'PASS') process.exitCode = 1;
