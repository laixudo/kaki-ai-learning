import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_TASK15_STUDENT_PASSWORD;
if (!password) throw new Error('Student acceptance credential is missing');
const root = path.resolve('..');
const evidence = path.join(root, 'evidence', '15');
const shots = path.join(evidence, 'screenshots');
const tests = path.join(evidence, 'tests');
await Promise.all([shots, tests].map((dir) => mkdir(dir, { recursive: true })));
const user = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8')).a;
const suffix = Date.now().toString().slice(-6);
const markerA = `隔离A-${suffix}`;
const markerB = `隔离B-${suffix}`;
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 1200) });
const audit = { console_errors: [], page_errors: [], http_errors: [] };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(90_000);
page.on('console', (message) => { if (message.type() === 'error') audit.console_errors.push(message.text()); });
page.on('pageerror', (error) => audit.page_errors.push(error.message));
page.on('response', (response) => { if (response.status() >= 400) audit.http_errors.push({ status: response.status(), method: response.request().method(), url: response.url() }); });
page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/chat/')) console.log(`CHAT_REQUEST ${request.method()} ${new URL(request.url()).pathname}`); });

await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.getByTestId('auth-phone').fill(user.username);
await page.getByTestId('auth-password').fill(password);
await page.getByTestId('auth-submit').click();
await page.waitForURL(/\/ai-learning/);
await page.locator('#input').waitFor({ state: 'visible' });
await page.locator('#send').waitFor({ state: 'visible' });
await page.waitForFunction(() => !document.querySelector('#send')?.disabled);
await page.waitForFunction(() => Boolean(sessionStorage.getItem('ai_workspace_test_thread_id')));

async function newConversation() {
  const before = await page.evaluate(() => sessionStorage.getItem('ai_workspace_test_thread_id'));
  await page.waitForFunction(() => !document.querySelector('#send')?.disabled);
  await page.waitForTimeout(500);
  const pending = page.waitForResponse((response) => response.url().includes('/api/chat/conversations') && response.request().method() === 'POST');
  await page.locator('#newChat').click();
  const response = await pending;
  await page.waitForFunction((oldThread) => sessionStorage.getItem('ai_workspace_test_thread_id') !== oldThread, before);
  const current = await page.evaluate(() => sessionStorage.getItem('ai_workspace_test_thread_id'));
  check(`conversation-created-${checks.length}`, response.status() === 200 && current && current !== before, `thread=${current}`);
  return current;
}

async function sendMarker(marker) {
  const beforeAssistant = await page.locator('#messages .msg.assistant').count();
  await page.locator('#input').fill(`${marker}：请只用一句话解释什么是函数。`);
  await page.locator('#send').click();
  await page.locator('#messages .msg.user').filter({ hasText: marker }).waitFor();
  await page.waitForFunction((count) => document.querySelectorAll('#messages .msg.assistant').length > count, beforeAssistant, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const send = document.querySelector('#send');
    const stop = document.querySelector('#stop');
    return Boolean(send && !send.disabled && stop && stop.hidden);
  }, undefined, { timeout: 120_000 });
  check(`provider-replied-${marker}`, true, `assistant_count>${beforeAssistant}`);
}

const threadA = await page.evaluate(() => sessionStorage.getItem('ai_workspace_test_thread_id'));
check('conversation-a-initialized', Boolean(threadA), `thread=${threadA}`);
await sendMarker(markerA);
await page.screenshot({ path: path.join(shots, '45-conversation-isolation-a.png'), fullPage: true });
const threadB = await newConversation();
await sendMarker(markerB);
await page.screenshot({ path: path.join(shots, '46-conversation-isolation-b.png'), fullPage: true });

await page.locator('#sessions .session').filter({ hasText: markerA }).click();
await page.waitForFunction((thread) => sessionStorage.getItem('ai_workspace_test_thread_id') === thread, threadA);
const visibleA = await page.locator('#messages').innerText();
check('conversation-a-content-isolated', visibleA.includes(markerA) && !visibleA.includes(markerB), `thread=${threadA}`);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#input').waitFor({ state: 'visible' });
const refreshedA = await page.locator('#messages').innerText();
check('conversation-a-refresh-persistence', refreshedA.includes(markerA) && !refreshedA.includes(markerB), `thread=${threadA}`);

await page.locator('#sessions .session').filter({ hasText: markerB }).click();
await page.waitForFunction((thread) => sessionStorage.getItem('ai_workspace_test_thread_id') === thread, threadB);
const visibleB = await page.locator('#messages').innerText();
check('conversation-b-content-isolated', visibleB.includes(markerB) && !visibleB.includes(markerA), `thread=${threadB}`);
check('distinct-conversation-ids', threadA !== threadB, JSON.stringify({ thread_a: threadA, thread_b: threadB }));
check('no-console-errors', audit.console_errors.length === 0, JSON.stringify(audit.console_errors));
check('no-page-errors', audit.page_errors.length === 0, JSON.stringify(audit.page_errors));
check('no-http-errors', audit.http_errors.length === 0, JSON.stringify(audit.http_errors));

const report = { generated_at: new Date().toISOString(), status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL', user_id: user.user_id, thread_ids: { a: threadA, b: threadB }, checks, audit };
await writeFile(path.join(tests, 'two-conversation-isolation-report.json'), JSON.stringify(report, null, 2));
await context.close();
await browser.close();
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exit(1);
