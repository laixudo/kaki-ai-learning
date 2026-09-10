import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_TASK16_STUDENT_PASSWORD;
if (!password) throw new Error('KAKI_TASK16_STUDENT_PASSWORD is required');

const project = path.resolve('..');
const evidence = path.join(project, 'evidence', '16A');
const tests = path.join(evidence, 'tests');
const inputDir = path.join(evidence, 'input');
await Promise.all([tests, inputDir].map((dir) => mkdir(dir, { recursive: true })));
const users = JSON.parse(await readFile(path.join(project, 'evidence', '15', 'task15-test-users.json'), 'utf8'));
const inputImage = path.join(inputDir, 'ordinary-study-note.png');
const report = { generated_at: new Date().toISOString(), status: 'FAIL', checks: [], audit: { console_errors: [], page_errors: [], http_errors: [] } };
const check = (name, pass, detail = '') => report.checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 1200) });

const browser = await chromium.launch({ headless: true });
const imageContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const imagePage = await imageContext.newPage();
await imagePage.setContent(`<!doctype html><html><body style="margin:0;background:#fff;font-family:Arial,sans-serif;color:#111"><main style="padding:90px"><h1 style="font-size:54px">FUNCTION MONOTONICITY</h1><p style="font-size:38px;line-height:1.6">Derivative f'(x) &gt; 0 means the function is increasing.</p><p style="font-size:38px">Example: f(x) = x^2 on x &gt; 0.</p><p style="font-size:34px">Study note: check the interval first.</p></main></body></html>`);
await imagePage.screenshot({ path: inputImage });
await imageContext.close();

const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
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
page.setDefaultTimeout(120_000);
page.on('console', (message) => { if (message.type() === 'error') report.audit.console_errors.push(message.text()); });
page.on('pageerror', (error) => report.audit.page_errors.push(error.message));
page.on('response', (response) => { if (response.status() >= 400) report.audit.http_errors.push({ status: response.status(), url: response.url() }); });

await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
await page.locator('#imageUpload').waitFor({ state: 'attached' });
await page.waitForFunction(() => typeof document.querySelector('#imageUpload')?.onchange === 'function');
let ocrPayload = null;
page.on('response', async (response) => {
  if (response.url().includes('/api/chat/input/ocr')) {
    try { ocrPayload = { status: response.status(), body: await response.json() }; } catch { ocrPayload = { status: response.status() }; }
  }
});
await page.locator('#imageUpload').setInputFiles(inputImage);
await page.waitForFunction(() => {
  const text = document.querySelector('#imageStatus')?.textContent || '';
  return text.includes('识别完成') || text.includes('失败');
}, null, { timeout: 180_000 });
const imageStatus = await page.locator('#imageStatus').textContent();
const recognized = await page.locator('#input').inputValue();
check('ordinary-study-image-selected', (await page.locator('#imageName').innerText()).includes('ordinary-study-note.png'));
check('real-ocr-endpoint-success', imageStatus?.includes('识别完成') && ocrPayload?.status === 200 && ocrPayload?.body?.data?.engine === 'rapidocr', JSON.stringify({ imageStatus, ocrPayload }));
check('ocr-text-entered-composer', /FUNCTION|MONOTONICITY|Derivative|increasing/i.test(recognized), recognized);

await page.locator('#input').fill(`${recognized}\n\n请只根据上面从图片识别出的学习笔记，用中文概括它的主题和判断步骤。`);
const assistantBefore = await page.locator('.msg.assistant').count();
await page.locator('#send').click();
await page.waitForFunction((before) => {
  const rows = [...document.querySelectorAll('.msg.assistant')];
  const last = rows.at(-1)?.querySelector('.message-bubble')?.textContent || '';
  const send = document.querySelector('#send');
  return rows.length > before && last.trim().length > 20 && !last.includes('正在思考') && !send?.disabled;
}, assistantBefore, { timeout: 180_000 });
await page.waitForTimeout(1500);
const assistantText = await page.locator('.msg.assistant .message-bubble').last().innerText().catch(() => '');
check('recognized-content-used-by-real-conversation', assistantText.length > 20 && /(单调|导数|递增|区间)/.test(assistantText), assistantText);
await page.screenshot({ path: path.join(tests, 'image-ocr-conversation-proof.png') });

check('no-page-errors', report.audit.page_errors.length === 0, JSON.stringify(report.audit.page_errors));
report.status = report.checks.every((item) => item.pass) ? 'PASS' : 'FAIL';
report.ocr = ocrPayload ? { http_status: ocrPayload.status, engine: ocrPayload.body?.data?.engine, confidence: ocrPayload.body?.data?.confidence, line_count: ocrPayload.body?.data?.line_count } : null;
report.recognized_excerpt = recognized.slice(0, 600);
report.assistant_excerpt = assistantText.slice(0, 1000);
await writeFile(path.join(tests, 'image-ocr-smoke-report.json'), JSON.stringify(report, null, 2));
await context.close();
await browser.close();
console.log(JSON.stringify({ status: report.status, checks: report.checks, ocr: report.ocr }, null, 2));
if (report.status !== 'PASS') process.exit(1);
