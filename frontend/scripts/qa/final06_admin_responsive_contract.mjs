import { chromium } from '@playwright/test';

const base = process.env.FINAL06_BASE_URL || 'http://127.0.0.1:5174';
const username = process.env.FINAL06_ADMIN_USERNAME;
const password = process.env.FINAL06_ADMIN_PASSWORD;
if (!username || !password) throw new Error('FINAL06_ADMIN_USERNAME and FINAL06_ADMIN_PASSWORD are required');

const browser = await chromium.launch({ headless: true });
const loginContext = await browser.newContext();
const login = await loginContext.request.post(`${base}/api/admin/login`, { data: { username, password } });
if (!login.ok()) throw new Error(`Admin login failed with HTTP ${login.status()}`);
const token = (await login.json()).data.token;
await loginContext.close();

const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await context.addInitScript((adminToken) => {
  localStorage.setItem('admin_token', adminToken);
  localStorage.setItem('admin_role', 'admin');
  localStorage.setItem('admin_user', JSON.stringify({ account: 'synthetic_admin', role: 'admin', name: '管理员' }));
}, token);
const page = await context.newPage();
const routes = [
  ['dashboard', '/admin/dashboard'],
  ['users', '/admin/users'],
  ['operations', '/admin/operations'],
  ['content', '/admin/content'],
  ['system', '/admin/system'],
];
const results = [];
for (const [module, route] of routes) {
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-testid="admin-page-${module}"]`).waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  results.push(await page.evaluate(({ module, route }) => ({
    module,
    route,
    finalPath: location.pathname,
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    modulePresent: Boolean(document.querySelector(`[data-testid="admin-page-${module}"]`)),
  }), { module, route }));
}
const failures = results.filter((item) => item.finalPath !== item.route || !item.modulePresent || item.overflow > 2);
console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', results, failures }, null, 2));
await browser.close();
if (failures.length) process.exit(1);

