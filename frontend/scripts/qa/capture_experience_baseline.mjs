import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.SHIGUANG_FRONTEND || 'http://127.0.0.1:5174';
const username = process.env.SHIGUANG_USER;
const password = process.env.SHIGUANG_PASSWORD || 'Manyou!2026';
const output = process.env.SHIGUANG_EVIDENCE || path.resolve('evidence/shiguang-manyou-20260718');
const prefix = process.env.SHIGUANG_PREFIX || 'before';
if (!username) throw new Error('SHIGUANG_USER is required');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
const page = await context.newPage();
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
if (!login.ok()) throw new Error(`login returned ${login.status()}: ${await login.text()}`);
const payload = await login.json();
const data = payload.data;
const user = { userId: data.user_id, username: data.username, email: data.email ?? null, avatarUrl: data.avatar_url ?? null, hasProfile: true };
await page.route('**/api/auth/me', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { user_id: user.userId, username: user.username, email: user.email, avatar_url: user.avatarUrl, has_profile: true } })
  });
});
await page.addInitScript(({ token, user: storedUser }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(storedUser));
  localStorage.setItem('ml_current_user_id', String(storedUser.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: data.token, user });

await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
await page.locator('#adventureEntry').waitFor({ state: 'visible' });
await page.locator('#adventureEntry').click();
await page.locator('.shiguang-overlay').waitFor({ state: 'visible' });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(output, `${prefix}-shiguang-prepare.png`), fullPage: true });
await page.locator('[data-action="leave"]').click();
await page.getByTestId('relax-moment-trigger').click();
await page.getByTestId('relax-moment-overlay').waitFor({ state: 'visible' });
const relax = page.getByTestId('relax-moment-overlay');
const relaxBox = await relax.boundingBox();
if (relaxBox) {
  await relax.click({ position: { x: relaxBox.width * 0.31, y: relaxBox.height * 0.34 } });
  await page.waitForTimeout(120);
  await relax.click({ position: { x: relaxBox.width * 0.68, y: relaxBox.height * 0.3 } });
  await page.waitForTimeout(120);
  await relax.click({ position: { x: relaxBox.width * 0.51, y: relaxBox.height * 0.45 } });
}
await page.waitForTimeout(420);
await page.screenshot({ path: path.join(output, `${prefix}-relax-moment.png`), fullPage: true });

console.log(JSON.stringify({ status: errors.length ? 'FAIL' : 'PASS', errors, output }, null, 2));
await browser.close();
