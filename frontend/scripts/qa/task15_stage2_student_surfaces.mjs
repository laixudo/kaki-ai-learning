import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_PASSWORD || 'KakiTask15!2026';
const project = path.resolve('..');
const evidence = path.join(project, 'evidence', '15');
const users = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8'));
await mkdir(path.join(evidence, 'screenshots'), { recursive: true });
await mkdir(path.join(evidence, 'tests'), { recursive: true });

const checks = [];
const audit = { console_errors: [], page_errors: [], http_errors: [], request_failures: [] };
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password } });
if (!login.ok()) throw new Error(`Login failed: ${login.status()}`);
const identity = (await login.json()).data;
await context.addInitScript(({ token, user }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true } });

const page = await context.newPage();
page.setDefaultTimeout(90_000);
page.on('console', message => { if (message.type() === 'error') audit.console_errors.push(message.text()); });
page.on('pageerror', error => audit.page_errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) audit.http_errors.push({ status: response.status(), url: response.url() }); });
page.on('requestfailed', request => audit.request_failures.push({ url: request.url(), error: request.failure()?.errorText || '' }));

const marker = `Task15 函数单调性真实笔记 ${Date.now()}`;
const original = '今天学习了函数单调性：在给定区间内，函数值随自变量增大而增大时是增函数。判断时需要明确区间，并可用定义或导数验证。';
await page.goto(`${base}/notes`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '新建笔记' }).first().click();
const title = page.getByPlaceholder('笔记标题');
const editor = page.getByPlaceholder('在这里写下你的理解、感悟和思考…');
await title.fill(marker);
await editor.fill(original);
await page.locator('[data-state="saved"]').waitFor({ timeout: 20_000 });
check('note-created-and-saved', (await title.inputValue()) === marker && (await editor.inputValue()).includes('函数单调性'));
await page.screenshot({ path: path.join(evidence, 'screenshots', '26-note-saved.png') });

await page.getByTestId('notes-ai-drawer-open').click();
await page.getByRole('button', { name: '润色整理' }).click();
const result = page.getByTestId('note-ai-result');
await result.waitFor({ state: 'visible', timeout: 120_000 });
const preview = await page.getByTestId('note-ai-preview').innerText();
check('notes-real-ai-result', preview.trim().length > 40 && preview.trim() !== original, preview.slice(0, 180));
await page.screenshot({ path: path.join(evidence, 'screenshots', '27-note-ai-result.png') });
await page.getByTestId('note-ai-replace').click();
await page.locator('[data-state="saved"]').waitFor({ timeout: 20_000 });
const replaced = await editor.inputValue();
check('notes-ai-writeback-applied', replaced.includes(preview.slice(0, 20)) && replaced !== original);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByText(marker, { exact: true }).first().click();
await page.getByPlaceholder('在这里写下你的理解、感悟和思考…').waitFor();
const persisted = await page.getByPlaceholder('在这里写下你的理解、感悟和思考…').inputValue();
check('note-persists-after-refresh-and-reopen', persisted === replaced, `length=${persisted.length}`);
await page.screenshot({ path: path.join(evidence, 'screenshots', '28-note-refresh-persisted.png') });

await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('mascot-companion').waitFor({ state: 'visible' });
await page.getByTestId('mascot-companion').click();
const inner = page.getByTestId('mascot-inner-world');
await inner.waitFor({ state: 'visible' });
await page.waitForFunction(() => !document.querySelector('[data-testid="mascot-inner-world"]')?.textContent?.includes('正在读取真实学习记录'));
const innerText = await inner.innerText();
check('inner-world-opens', innerText.includes('柿小吉眼中的你'));
check('inner-world-grounded', innerText.includes('已记录的学习线索') && (innerText.includes('当前学习进展') || innerText.includes('最近学习状态') || innerText.includes('最近生成的学习成果')), innerText.slice(0, 300));
check('inner-world-truthful-generation-status', await inner.getAttribute('data-generation-status') === 'GENERATIVE_EXPRESSION_BLOCKED');
await page.screenshot({ path: path.join(evidence, 'screenshots', '29-inner-world.png') });
await page.getByTestId('mascot-inner-world-close').click();

await page.getByTestId('mascot-relax-button').click();
const relax = page.getByTestId('relax-moment-overlay');
await relax.waitFor({ state: 'visible' });
await page.waitForTimeout(1800);
const audioState = await page.evaluate(() => window.KakiAudioManager?.getState?.() || null);
check('relax-opens', await relax.isVisible());
check('relax-real-audio-state', audioState?.type === 'relax_fireworks' && audioState?.paused === false, JSON.stringify(audioState));
await page.screenshot({ path: path.join(evidence, 'screenshots', '30-relax-moment.png') });
await page.getByRole('button', { name: '结束轻松一下' }).click();
await relax.waitFor({ state: 'detached' });
check('relax-closes-and-returns', await page.locator('#workspaceApp').isVisible());

check('no-console-errors', audit.console_errors.length === 0, JSON.stringify(audit.console_errors));
check('no-page-errors', audit.page_errors.length === 0, JSON.stringify(audit.page_errors));
check('no-http-errors', audit.http_errors.length === 0, JSON.stringify(audit.http_errors));
const report = { generated_at: new Date().toISOString(), status: checks.every(item => item.pass) ? 'PASS' : 'FAIL', user_id: identity.user_id, note_title: marker, checks, audit };
await writeFile(path.join(evidence, 'tests', 'stage2-student-surfaces-report.json'), JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 1);
