import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_TASK16_STUDENT_PASSWORD;
if (!password) throw new Error('KAKI_TASK16_STUDENT_PASSWORD is required');
const project = path.resolve('..');
const evidence = path.join(project, 'evidence', '16A');
const shots = path.join(evidence, 'screenshots');
const users = JSON.parse(await readFile(path.join(project, 'evidence', '15', 'task15-test-users.json'), 'utf8'));
const report = { generated_at: new Date().toISOString(), repaired: [], blocked: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password } });
const identity = (await login.json()).data;
await context.addInitScript(({ token, user }) => {
  localStorage.setItem('token', token); localStorage.setItem('auth_token', token); localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user)); localStorage.setItem('ml_current_user_id', String(user.userId)); localStorage.setItem('kaki_profile_status', 'complete');
}, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true } });
const page = await context.newPage(); page.setDefaultTimeout(60_000);
const capture = async (name, state) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(shots, name), fullPage: false, animations: 'disabled' }); report.repaired.push({ file: name, state }); };

// Companion controls are opened by the product's real double-click gesture.
await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('mascot-companion').waitFor();
await page.getByTestId('mascot-companion').evaluate((node) => node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
await page.getByText('移到左侧', { exact: true }).waitFor();
await capture('09-living-companion-actions.png', 'real companion control menu opened by double click');

// Voice readiness: direct DOM click is the same product handler and avoids an unrelated tray backdrop.
await page.evaluate(() => document.querySelector('#callTool')?.click());
await page.locator('#kakiVoiceCall').waitFor({ state: 'visible', timeout: 30_000 });
await capture('06-ai-workspace-call-1920.png', 'real voice-call shell visible; headless microphone may be unavailable');
await page.evaluate(() => document.querySelector('#voiceCallEnd')?.click());

// Notes AI requires selecting a real note before opening the drawer.
await page.goto(`${base}/notes`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('notes-page').waitFor();
await page.locator('[class*="noteItem"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
const note = page.locator('[class*="noteItem"]').first();
if (await note.count()) {
  await note.click(); await page.getByPlaceholder('在这里写下你的理解、感悟和思考…').waitFor();
  await capture('17-notes-overview-1920.png', 'real selected note overview');
  await page.getByTestId('notes-ai-drawer-open').first().click(); await page.getByTestId('notes-ai-drawer').waitFor();
  await capture('18-notes-ai-drawer-1920.png', 'notes AI drawer for selected real note');
  await page.getByRole('button', { name: '润色整理' }).click();
  try { await page.getByTestId('note-ai-result').waitFor({ timeout: 180_000 }); await capture('19-notes-ai-result-1920.png', 'real notes AI result'); }
  catch (error) { report.blocked.push({ file: '19-notes-ai-result-1920.png', reason: `real AI result timeout: ${error.message}` }); }
} else report.blocked.push({ file: '17-19 notes', reason: 'real note could not be selected' });

// Existing completed exam can still enter the formal runner for a truthful question view.
await page.goto(`${base}/exam`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('module-page-exam').waitFor();
await page.getByText('可参加考试', { exact: true }).waitFor();
await page.waitForTimeout(1200);
const availableReport = page.getByRole('button', { name: '查看报告', exact: true }).first();
if (await availableReport.count()) {
  await availableReport.click(); await page.getByTestId('exam-runner').waitFor();
  await capture('23-practice-start-1920.png', 'real exam confirmation/start state');
  await page.getByRole('button', { name: '确认开始考试', exact: true }).click();
  await page.locator('[data-testid="exam-runner"][data-phase="running"]').waitFor();
  await capture('24-practice-question-1920.png', 'real formal exam question state');
  const radio = page.locator('[data-testid="exam-runner"] input[type="radio"]').first();
  if (await radio.count()) await radio.check();
  const text = page.locator('[data-testid="exam-runner"] textarea').first(); if (await text.count()) await text.fill('根据定义和导数符号判断。');
  await page.getByRole('button', { name: '提交答卷', exact: true }).click();
  await page.locator('[data-testid="exam-runner"][data-phase="result"]').waitFor({ timeout: 60_000 });
  await capture('25-practice-feedback-1920.png', 'real server-graded practice feedback/result');
} else report.blocked.push({ file: '23-25 practice', reason: 'no real persisted exam was available' });

await writeFile(path.join(evidence, 'tests', 'repair-blocked-states-report.json'), JSON.stringify(report, null, 2));
await context.close(); await browser.close();
console.log(JSON.stringify({ repaired: report.repaired.length, blocked: report.blocked.length }, null, 2));
