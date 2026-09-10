import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_PASSWORD || 'KakiTask15!2026';
const evidence = path.resolve('..', 'evidence', '15');
const users = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8'));
const voiceReport = JSON.parse(await readFile(path.join(evidence, 'voice-call-real', 'voice-call-report.json'), 'utf8'));
const tutorThread = voiceReport?.bound_context?.thread_ref;
if (!tutorThread) throw new Error('Tutor thread missing from voice-call evidence');
await mkdir(path.join(evidence, 'screenshots'), { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password } });
if (!login.ok()) throw new Error(`login ${login.status()}`);
const identity = (await login.json()).data;
await context.addInitScript(({ token, user, tutorThread }) => {
  localStorage.setItem('token', token); localStorage.setItem('auth_token', token); localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user)); localStorage.setItem('ml_current_user_id', String(user.userId)); localStorage.setItem('kaki_profile_status', 'complete');
  sessionStorage.setItem('ai_workspace_test_thread_id', tutorThread);
}, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true }, tutorThread });
const page = await context.newPage();
page.setDefaultTimeout(120_000);
const audit = { console_errors: [], page_errors: [], http_errors: [] };
page.on('console', m => { if (m.type() === 'error') audit.console_errors.push(m.text()); });
page.on('pageerror', e => audit.page_errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) audit.http_errors.push({ status: r.status(), url: r.url() }); });
await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.KakiWorkspaceRuntimeBridge));
const bound = voiceReport.bound_context;
const startButtons = page.getByRole('button', { name: '开始作答', exact: true });
await startButtons.last().waitFor({ state: 'visible' });
const examResponsePromise = page.waitForResponse(r => /\/api\/exam\/\d+$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET');
await startButtons.last().click();
const examResponse = await examResponsePromise;
const examPayload = await examResponse.json();
const exam = examPayload.data;
await page.locator('#artifactDrawer:not([hidden])').waitFor({ state: 'visible' });
const questions = page.locator('#artifactContent .exam-question');
const count = await questions.count();
for (let i = 0; i < count; i += 1) {
  const question = questions.nth(i);
  const radio = question.locator('input[type="radio"]');
  if (await radio.count()) await radio.first().check();
  else {
    const textarea = question.locator('textarea');
    if (await textarea.count()) await textarea.fill('我先说明函数单调性需要明确区间，再通过导数符号判断增减，并用端点和极值验证结论。');
  }
}
await page.screenshot({ path: path.join(evidence, 'screenshots', '31-formal-practice-answered.png') });
const submitResponsePromise = page.waitForResponse(r => /\/api\/chat\/tasks\/exam\/\d+\/submit$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 180_000 });
await page.getByRole('button', { name: '提交答案', exact: true }).click();
const submitResponse = await submitResponsePromise;
const submitPayload = await submitResponse.json();
await page.locator('#artifactDrawer').waitFor({ state: 'hidden' });
const latest = await context.request.get(`${base}/api/learning-evaluations/graphs/${encodeURIComponent(bound.graph_ref.graph_id)}/nodes/${encodeURIComponent(bound.node_ref.node_id)}/latest`, { headers: { Authorization: `Bearer ${identity.token}` } });
const latestPayload = latest.ok() ? await latest.json() : null;
const beforeAssistant = await page.locator('.msg.assistant').count();
await page.locator('#input').fill('请根据我刚才提交的正式练习证据，直接告诉我下一步怎么学。');
await page.locator('#send').click();
await page.waitForFunction(n => document.querySelectorAll('.msg.assistant').length > n && !document.querySelector('#send')?.disabled, beforeAssistant, { timeout: 180_000 });
const teaching = await page.locator('.msg.assistant').last().innerText();
await page.screenshot({ path: path.join(evidence, 'screenshots', '32-evidence-informed-teaching.png') });
const checks = [
  { name: 'formal-exam-loaded-in-conversation', pass: examResponse.ok() && count > 0, detail: `exam=${exam?.id} questions=${count}` },
  { name: 'formal-exam-submit-200', pass: submitResponse.ok(), detail: JSON.stringify(submitPayload?.data || {}) },
  { name: 'evaluator-ran-or-truthfully-pending', pass: ['evaluated', 'evaluation_pending', 'evaluation_blocked'].includes(submitPayload?.data?.evaluation_status), detail: JSON.stringify({ status: submitPayload?.data?.evaluation_status, revision: submitPayload?.data?.evaluation_revision, evidence_pending: submitPayload?.data?.evidence_pending }) },
  { name: 'latest-evaluation-readable', pass: latest.ok(), detail: JSON.stringify(latestPayload?.data || null) },
  { name: 'teaching-continues-after-formal-evidence', pass: teaching.trim().length > 20, detail: teaching.slice(0, 500) },
  { name: 'no-console-errors', pass: audit.console_errors.length === 0, detail: JSON.stringify(audit.console_errors) },
  { name: 'no-page-errors', pass: audit.page_errors.length === 0, detail: JSON.stringify(audit.page_errors) },
  { name: 'no-http-errors', pass: audit.http_errors.length === 0, detail: JSON.stringify(audit.http_errors) }
];
const report = { generated_at: new Date().toISOString(), status: checks.every(x => x.pass) ? 'PASS' : 'FAIL', identity: { user_id: identity.user_id }, bound_context: bound, exam: { id: exam?.id, question_count: count }, submission: submitPayload?.data || null, latest_evaluation: latestPayload?.data || null, teaching_excerpt: teaching.slice(0, 1000), checks, audit };
await writeFile(path.join(evidence, 'tests', 'formal-practice-evaluator-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(report.status === 'PASS' ? 0 : 1);
