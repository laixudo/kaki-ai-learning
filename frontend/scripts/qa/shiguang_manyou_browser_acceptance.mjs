import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.SHIGUANG_FRONTEND || 'http://127.0.0.1:5174';
const output = process.env.SHIGUANG_EVIDENCE || path.resolve('evidence/shiguang-manyou-20260718');
await mkdir(output, { recursive: true });
const stamp = new Date().toISOString().replace(/\D/g, '');
const username = `manyou_browser_${stamp}`;
const password = 'Manyou!2026';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const forbiddenRequests = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });
page.on('request', (request) => { if (/127\.0\.0\.1:(8000|8765)/.test(request.url())) forbiddenRequests.push(request.url()); });

const register = await context.request.post(`${base}/api/auth/register`, { data: { username, password, email: `${username}@example.test` } });
if (!register.ok()) throw new Error(`register returned ${register.status()}: ${await register.text()}`);
const registered = (await register.json()).data;
const user = { userId: registered.user_id, username, email: `${username}@example.test`, avatarUrl: null, hasProfile: true };
await page.route('**/api/auth/me', async (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ success: true, data: { user_id: user.userId, username, email: user.email, avatar_url: null, has_profile: true } })
}));
await page.addInitScript(({ token, storedUser }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(storedUser));
  localStorage.setItem('ml_current_user_id', String(storedUser.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: registered.token, storedUser: user });

const overlay = page.locator('.shiguang-overlay');
const state = async (expected) => {
  await page.waitForFunction((value) => document.querySelector('.shiguang-overlay')?.getAttribute('data-state') === value, expected);
};
const shot = async (name) => { await page.waitForTimeout(720); return page.screenshot({ path: path.join(output, name), fullPage: true }); };
const clickAction = async (action) => page.locator(`[data-action="${action}"]`).evaluate((button) => button.click());
const drainDialogue = async () => {
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
};
const settle = async () => {
  await page.waitForFunction(() => {
    const current = document.querySelector('.shiguang-overlay');
    const phase = current?.dataset.directionPhase || '';
    return current && !current.classList.contains('is-busy') && (phase === 'dialogue' || phase === 'interactive');
  }, null, { timeout: 25_000 });
  if (await page.locator('.shiguang-dialogue').count()) await drainDialogue();
  await page.waitForFunction(() => {
    const current = document.querySelector('.shiguang-overlay');
    return current && !current.classList.contains('is-busy')
      && current.dataset.directionPhase === 'interactive'
      && !document.querySelector('.shiguang-dialogue');
  }, null, { timeout: 25_000 });
};
const enterLearningPanel = async () => {
  await settle();
  if (!await page.locator('.shiguang-destination-choice').count()) return;
  const stay = page.locator('[data-action="destination"][data-destination-kind="stay"]');
  const destination = await stay.count()
    ? stay
    : page.locator('[data-action="destination"][data-destination-kind="travel"]').first();
  await destination.click();
  await settle();
};
const finishJourney = async ({ capture = false, fromScroll = false } = {}) => {
  await enterLearningPanel();
  if (!fromScroll) { await clickAction('continue'); await state('scroll'); await enterLearningPanel(); }
  if (capture) await shot('after-shiguang-scroll.png');
  await clickAction('continue'); await state('method'); await enterLearningPanel();
  if (capture) await shot('after-shiguang-method.png');
  await page.locator('[data-action="method"][data-method="practice"]').click(); await state('trial'); await enterLearningPanel();
  if (capture) await shot('after-shiguang-trial.png');
  await page.locator('[data-action="answer"]').first().click(); await state('supply'); await enterLearningPanel();
  await clickAction('continue'); await state('interleave'); await enterLearningPanel();
  await page.locator('.shiguang-answer textarea').fill('我会用正则化减少过拟合');
  await page.locator('.shiguang-answer').evaluate((form) => form.requestSubmit()); await state('boss'); await enterLearningPanel();
  if (capture) await shot('after-shiguang-boss-stage-1.png');
  await page.locator('.shiguang-answer textarea').fill('泛化能力是模型在未见新数据上的表现');
  await page.locator('.shiguang-answer').evaluate((form) => form.requestSubmit());
  await enterLearningPanel();
  await page.waitForFunction(() => document.querySelectorAll('.shiguang-boss-seals .lit').length === 1);
  await page.locator('[data-action="answer"]').first().click();
  await enterLearningPanel();
  await page.waitForFunction(() => document.querySelectorAll('.shiguang-boss-seals .lit').length === 2);
  await page.locator('.shiguang-answer textarea').fill('这是过拟合，我会使用早停来改善泛化');
  await page.locator('.shiguang-answer').evaluate((form) => form.requestSubmit()); await state('treasury'); await enterLearningPanel();
  if (capture) await shot('after-shiguang-treasury.png');
  await clickAction('claim'); await state('completed'); await settle();
  if (capture) await shot('after-shiguang-completed.png');
};

await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
await page.locator('#input').fill('旅程返回后保留这段草稿');
await page.locator('#adventureEntry').click();
await overlay.waitFor({ state: 'visible' });
await page.locator('#shiguangTopic').fill('机器学习模型评估');
await page.locator('input[name="source"][value="manual"]').check();
await page.locator('.shiguang-schools label[data-school="wood"]').click();
await page.locator('[data-action="confirm-school"]').click();
await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
await shot('after-shiguang-prepare-browser.png');
await clickAction('start'); await state('goal');
await shot('after-shiguang-goal.png');
await finishJourney({ capture: true });
const artifactText = await page.locator('.shiguang-treasure').innerText();
await clickAction('return');
const preservedDraft = await page.locator('#input').inputValue();

await page.locator('#adventureEntry').click();
await page.locator('#shiguangTopic').fill('机器学习模型评估 · 刷新续玩');
await page.locator('input[name="source"][value="manual"]').check();
await page.locator('.shiguang-schools label[data-school="wood"]').click();
await page.locator('[data-action="confirm-school"]').click();
await page.waitForFunction(() => document.querySelector('[data-action="start"]')?.disabled === false);
await clickAction('start'); await state('goal');
await enterLearningPanel();
await clickAction('continue'); await state('scroll');
await clickAction('leave');
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#adventureEntry').click();
await state('scroll');
const restoredState = await overlay.getAttribute('data-state');
await finishJourney({ fromScroll: true });
await clickAction('return');

const report = {
  status: consoleErrors.length || pageErrors.length || failedResponses.length || forbiddenRequests.length || preservedDraft !== '旅程返回后保留这段草稿' || restoredState !== 'scroll' ? 'FAIL' : 'PASS',
  frontend_url: base,
  user_id: registered.user_id,
  username,
  journey: {
    eight_nodes_completed: true,
    boss_stages: 3,
    artifact_confirmation: artifactText.includes('产物 ID'),
    draft_preserved: preservedDraft === '旅程返回后保留这段草稿',
    refresh_restored_state: restoredState,
  },
  console_errors: consoleErrors,
  page_errors: pageErrors,
  http_4xx_5xx: failedResponses,
  forbidden_8000_or_8765_requests: forbiddenRequests,
  screenshots: [
    'after-shiguang-prepare-browser.png', 'after-shiguang-goal.png', 'after-shiguang-scroll.png',
    'after-shiguang-method.png', 'after-shiguang-trial.png', 'after-shiguang-boss-stage-1.png',
    'after-shiguang-treasury.png', 'after-shiguang-completed.png'
  ].map((name) => path.join(output, name))
};
await writeFile(path.join(output, 'browser-journey-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exitCode = report.status === 'PASS' ? 0 : 1;
