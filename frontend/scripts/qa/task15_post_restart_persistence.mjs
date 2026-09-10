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
const noteTitle = JSON.parse(await readFile(path.join(tests, 'stage2-student-surfaces-report.json'), 'utf8')).note_title;
const conversations = JSON.parse(await readFile(path.join(tests, 'two-conversation-isolation-report.json'), 'utf8')).thread_ids;
const runtime = JSON.parse(await readFile(path.join(root, '.runtime', 'processes.json'), 'utf8'));
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 1400) });
const audit = { console_errors: [], page_errors: [], http_errors: [] };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(90_000);
page.on('console', (message) => { if (message.type() === 'error') audit.console_errors.push(message.text()); });
page.on('pageerror', (error) => audit.page_errors.push(error.message));
page.on('response', (response) => { if (response.status() >= 400) audit.http_errors.push({ status: response.status(), method: response.request().method(), url: response.url() }); });

const health = await page.request.get('http://127.0.0.1:8001/api/health');
check('backend-healthy-after-official-restart', health.status() === 200, `pid=${runtime.backend}; status=${health.status()}`);
const frontend = await page.request.get(`${base}/`);
check('frontend-healthy-after-official-restart', frontend.status() === 200, `pid=${runtime.frontend}; status=${frontend.status()}`);

await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.getByTestId('auth-phone').fill(user.username);
await page.getByTestId('auth-password').fill(password);
await page.getByTestId('auth-submit').click();
await page.waitForURL(/\/ai-learning/);
await page.locator('#input').waitFor({ state: 'visible' });
await page.locator('#sessions .session').filter({ hasText: '隔离A-' }).first().click();
await page.waitForFunction((thread) => sessionStorage.getItem('ai_workspace_test_thread_id') === thread, conversations.a);
const conversationAText = await page.locator('#messages').innerText();
check('conversation-persists-after-service-restart', conversationAText.includes('隔离A-') && !conversationAText.includes('隔离B-'), `thread=${conversations.a}`);

await page.goto(`${base}/notes`, { waitUntil: 'networkidle' });
await page.getByText(noteTitle, { exact: true }).first().waitFor();
await page.getByText(noteTitle, { exact: true }).first().click();
const noteBody = await page.getByPlaceholder('在这里写下你的理解、感悟和思考…').inputValue();
check('note-and-ai-writeback-persist-after-service-restart', noteBody.length > 40, `title=${noteTitle}; body_chars=${noteBody.length}`);

await page.goto(`${base}/resources`, { waitUntil: 'networkidle' });
const materialText = await page.locator('body').innerText();
check('uploaded-material-persists-after-service-restart', materialText.includes('task15-learning-note'), 'material title visible in owned library');

await page.goto(`${base}/artifacts`, { waitUntil: 'networkidle' });
const artifactText = await page.locator('body').innerText();
check('generated-lecture-artifact-persists-after-service-restart', artifactText.includes('函数单调性讲义'), 'artifact 48 title visible');

const token = await page.evaluate(() => localStorage.getItem('token'));
const examResponse = await page.request.get('http://127.0.0.1:8001/api/exam/23', { headers: { Authorization: `Bearer ${token}` } });
const examBody = examResponse.status() === 200 ? await examResponse.json() : null;
check('formal-exam-result-persists-after-service-restart', examResponse.status() === 200 && Boolean(examBody?.data ?? examBody), `exam_id=23; status=${examResponse.status()}`);

await page.goto(`${base}/learning`, { waitUntil: 'networkidle' });
await page.getByTestId('learning-route-journey').getByRole('button', { name: '进入学习' }).click();
await page.getByTestId('learning-graph-toggle').click();
await page.getByText('学习效果评估', { exact: true }).first().waitFor();
const learningText = await page.locator('body').innerText();
check('learning-plan-and-evaluator-persist-after-service-restart', learningText.includes('证据仍不足') && learningText.includes('函数与导数'), 'formal graph and evaluator revision visible');
await page.screenshot({ path: path.join(shots, '47-post-restart-persistence.png'), fullPage: true });

check('no-console-errors', audit.console_errors.length === 0, JSON.stringify(audit.console_errors));
check('no-page-errors', audit.page_errors.length === 0, JSON.stringify(audit.page_errors));
check('no-http-errors', audit.http_errors.length === 0, JSON.stringify(audit.http_errors));
const report = { generated_at: new Date().toISOString(), status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL', restart_processes: runtime, user_id: user.user_id, persisted_ids: { conversation_a: conversations.a, conversation_b: conversations.b, exam_id: 23, artifact_id: 48 }, checks, audit };
await writeFile(path.join(tests, 'post-restart-persistence-report.json'), JSON.stringify(report, null, 2));
await context.close();
await browser.close();
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exit(1);
