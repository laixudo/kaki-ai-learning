import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_PASSWORD || 'KakiTask15!2026';
const evidence = path.resolve('..', 'evidence', '15');
const users = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password } });
if (!login.ok()) throw new Error(`login ${login.status()}`);
const identity = (await login.json()).data;
await context.addInitScript(({ token, user }) => {
  localStorage.setItem('token', token); localStorage.setItem('auth_token', token); localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user)); localStorage.setItem('ml_current_user_id', String(user.userId)); localStorage.setItem('kaki_profile_status', 'complete');
}, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true } });
const page = await context.newPage();
page.setDefaultTimeout(180_000);
const audit = { console_errors: [], page_errors: [], http_errors: [] };
page.on('console', m => { if (m.type() === 'error') audit.console_errors.push(m.text()); });
page.on('pageerror', e => audit.page_errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) audit.http_errors.push({ status: r.status(), url: r.url() }); });
await page.goto(`${base}/learning`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('learning-route-journey').getByRole('button', { name: '进入学习', exact: true }).click();
await page.getByTestId('learning-current-task').waitFor({ state: 'visible' });
await page.getByTestId('learning-graph-toggle').click();
const graph = page.getByTestId('formal-learning-graph');
await graph.waitFor({ state: 'visible' });
const currentNodeId = 'node_353560c4c86924cd';
let panel = page.getByTestId(`node-evaluation-${currentNodeId}`);
if (!(await panel.count())) panel = graph.locator('[data-testid^="node-evaluation-"]').first();
await panel.scrollIntoViewIfNeeded();
const button = panel.getByRole('button', { name: /评估当前学习证据|根据最新证据重新评估/ });
const evalResponsePromise = page.waitForResponse(r => /\/api\/learning-evaluations\/graphs\/[^/]+\/nodes\/[^/]+\/evaluate$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 240_000 });
await button.click();
const evalResponse = await evalResponsePromise;
const evalPayload = await evalResponse.json();
await page.waitForFunction(testId => {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  return el && /评估状态|证据数量|还缺少的证据|下一步建议/.test(el.textContent || '');
}, await panel.getAttribute('data-testid'), { timeout: 180_000 });
const panelText = await panel.innerText();
await page.screenshot({ path: path.join(evidence, 'screenshots', '33-explicit-evaluator-ui.png'), fullPage: true });
const data = evalPayload?.data || null;
const checks = [
  { name: 'evaluator-ui-submit-200', pass: evalResponse.ok(), detail: `status=${evalResponse.status()}` },
  { name: 'evaluator-public-result-returned', pass: Boolean(data?.evaluation_revision || data?.assessment || data?.evidence_summaries), detail: JSON.stringify(data) },
  { name: 'evaluator-visible-on-my-learning', pass: /评估状态|证据数量/.test(panelText), detail: panelText.slice(0, 800) },
  { name: 'no-console-errors', pass: audit.console_errors.length === 0, detail: JSON.stringify(audit.console_errors) },
  { name: 'no-page-errors', pass: audit.page_errors.length === 0, detail: JSON.stringify(audit.page_errors) },
  { name: 'no-http-errors', pass: audit.http_errors.length === 0, detail: JSON.stringify(audit.http_errors) }
];
const report = { generated_at: new Date().toISOString(), status: checks.every(x => x.pass) ? 'PASS' : 'FAIL', user_id: identity.user_id, evaluation: data, visible_text: panelText, checks, audit };
await writeFile(path.join(evidence, 'tests', 'explicit-evaluator-ui-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(report.status === 'PASS' ? 0 : 1);
