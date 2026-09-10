import { chromium } from '@playwright/test';

const base = process.env.FINAL06_BASE_URL || 'http://127.0.0.1:5174';
const token = process.env.FINAL06_USER_TOKEN;
if (!token) throw new Error('FINAL06_USER_TOKEN is required');

const browser = await chromium.launch({ headless: true });
const identityContext = await browser.newContext();
const meResponse = await identityContext.request.get(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
if (!meResponse.ok()) throw new Error(`Identity failed with HTTP ${meResponse.status()}`);
const identity = (await meResponse.json()).data;
await identityContext.close();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await context.addInitScript(({ token: authToken, identity: current }) => {
  const user = { userId: current.user_id, username: current.username, email: null, avatarUrl: current.avatar_url ?? null, hasProfile: true };
  localStorage.setItem('token', authToken);
  localStorage.setItem('auth_token', authToken);
  localStorage.setItem('ml_auth_token', authToken);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token, identity });
const page = await context.newPage();

await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
const home = await page.evaluate((username) => {
  const h1 = document.querySelector('h1')?.textContent?.trim() ?? '';
  return { h1, rawUsernameInHero: Boolean(username && h1.includes(username)) };
}, identity.username);

await page.goto(`${base}/resources`, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="real-material-library"]').waitFor({ state: 'visible' });
await page.waitForTimeout(900);
const resources = await page.evaluate(() => ({
  empty: Boolean(document.querySelector('[data-testid="material-empty"]')),
  pageHeight: document.documentElement.scrollHeight,
  viewportHeight: window.innerHeight,
  mastheadText: document.querySelector('[data-testid="module-page-resources"] > section')?.textContent ?? '',
  horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
}));

const checks = {
  homeDoesNotLeadWithRawUsername: !home.rawUsernameInHero,
  resourcesNoHorizontalOverflow: resources.horizontalOverflow <= 2,
  emptyResourcesAreCompact: !resources.empty || resources.pageHeight <= resources.viewportHeight + 2,
  emptyResourcesHideZeroDashboard: !resources.empty || !/已上传资料\s*0.*可使用\s*0.*解析中\s*0.*解析失败\s*0/s.test(resources.mastheadText),
};
const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures, home, resources }, null, 2));
await browser.close();
if (failures.length) process.exit(1);
