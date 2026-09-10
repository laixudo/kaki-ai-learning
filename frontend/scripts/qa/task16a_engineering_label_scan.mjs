import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_TASK16_STUDENT_PASSWORD;
if (!password) throw new Error('KAKI_TASK16_STUDENT_PASSWORD is required');
const project = path.resolve('..');
const evidence = path.join(project, 'evidence', '16A', 'tests'); await mkdir(evidence, { recursive: true });
const users = JSON.parse(await readFile(path.join(project, 'evidence', '15', 'task15-test-users.json'), 'utf8'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password } });
const identity = (await login.json()).data;
await context.addInitScript(({ token, user }) => { localStorage.setItem('token', token); localStorage.setItem('auth_token', token); localStorage.setItem('ml_auth_token', token); localStorage.setItem('kaki_user', JSON.stringify(user)); localStorage.setItem('ml_current_user_id', String(user.userId)); localStorage.setItem('kaki_profile_status', 'complete'); }, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true } });
const page = await context.newPage();
const forbidden = [/\bnot_started\b/i, /tutor_action:/i, /UNCLASSIFIED_PRIVATE_SIGNAL/i, /waiting-for-first-action/i, /画像版本/i, /来自后端/i];
const rows = [];
for (const route of ['/ai-learning', '/learning', '/profile']) {
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
  if (route === '/ai-learning') { await page.getByTestId('mascot-companion').click(); await page.getByTestId('mascot-inner-world').waitFor(); await page.waitForTimeout(700); }
  const text = await page.locator('body').innerText();
  rows.push({ route, hits: forbidden.filter((pattern) => pattern.test(text)).map(String) });
}
const report = { generated_at: new Date().toISOString(), status: rows.every((row) => row.hits.length === 0) ? 'PASS' : 'FAIL', rows };
await writeFile(path.join(evidence, 'engineering-label-scan.json'), JSON.stringify(report, null, 2));
await context.close(); await browser.close(); console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exit(1);
