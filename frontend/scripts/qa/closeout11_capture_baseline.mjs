import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
const username = process.env.KAKI_USER;
const password = process.env.KAKI_PASSWORD;
const adminUsername = process.env.KAKI_ADMIN_USER;
const adminPassword = process.env.KAKI_ADMIN_PASSWORD;
const output = process.env.KAKI_EVIDENCE || path.resolve('../evidence/11/baseline');
const onlyAdmin = process.env.KAKI_ONLY_ADMIN === '1';

if (!username || !password) throw new Error('KAKI_USER and KAKI_PASSWORD are required');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const loginContext = await browser.newContext();
const login = await loginContext.request.post(`${base}/api/auth/login`, { data: { username, password } });
if (!login.ok()) throw new Error(`student login failed with HTTP ${login.status()}`);
const auth = (await login.json()).data;
let admin = null;
if (adminUsername && adminPassword) {
  const response = await loginContext.request.post(`${base}/api/admin/login`, {
    data: { username: adminUsername, password: adminPassword },
  });
  if (response.ok()) admin = (await response.json()).data;
}
await loginContext.close();

const widths = process.env.KAKI_WIDTHS
  ? process.env.KAKI_WIDTHS.split(',').map(Number).filter(Number.isFinite)
  : [1920, 1600, 1366, 390];
const requestedRoutes = new Set((process.env.KAKI_ROUTES || '').split(',').filter(Boolean));
const allRoutes = [
  ['home', '/', '[data-testid="dashboard-page"]'],
  ['my-learning', '/learning', '[data-testid="mylearning-overview"]'],
  ['ai-workspace', '/ai-learning', '[data-testid="ai-learning-page"]'],
  ['materials', '/resources', '[data-testid="module-page-resources"]'],
  ['notes', '/notes', '[data-testid="notes-page"]'],
  ['profile', '/profile', '[data-testid="module-page-profile"]'],
  ['practice', '/exam', '[data-testid="module-page-exam"]'],
  ['artifacts', '/artifacts', '[data-testid="module-page-artifacts"]'],
];
const routes = onlyAdmin ? [] : allRoutes.filter(([name]) => !requestedRoutes.size || requestedRoutes.has(name));
const report = { status: 'PASS', base, identity: { user_id: auth.user_id, username: auth.username }, pages: [], errors: [] };

for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ token, userId, currentUsername, adminState }) => {
    const user = { userId, username: currentUsername, hasProfile: true };
    localStorage.setItem('token', token);
    localStorage.setItem('auth_token', token);
    localStorage.setItem('ml_auth_token', token);
    localStorage.setItem('kaki_user', JSON.stringify(user));
    localStorage.setItem('ml_current_user_id', String(userId));
    localStorage.setItem('kaki_profile_status', 'complete');
    if (adminState?.token) {
      localStorage.setItem('admin_token', adminState.token);
      localStorage.setItem('admin_role', 'admin');
      localStorage.setItem('admin_user', JSON.stringify(adminState.admin || {}));
    }
  }, { token: auth.token, userId: auth.user_id, currentUsername: auth.username, adminState: admin });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push({ type: 'console', width, url: page.url(), message: message.text() });
  });
  page.on('pageerror', (error) => report.errors.push({ type: 'pageerror', width, url: page.url(), message: error.message }));

  for (const [name, route, ready] of routes) {
    try {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.locator(ready).waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(900);
      const metrics = await page.evaluate(() => ({
        title: document.querySelector('h1')?.textContent?.trim() || '',
        bodyText: document.body.innerText.slice(0, 2400),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        height: document.documentElement.scrollHeight,
      }));
      const file = `${name}-${width}.png`;
      await page.screenshot({ path: path.join(output, file), fullPage: true });
      report.pages.push({ name, route, width, file, ...metrics });

      if (name === 'my-learning') {
        const enter = page.getByRole('button', { name: '进入学习', exact: true }).first();
        if (await enter.count()) {
          await enter.click();
          await page.locator('[data-testid="mylearning-detail"]').waitFor({ state: 'visible', timeout: 30_000 });
          await page.waitForTimeout(900);
          const detailMetrics = await page.evaluate(() => ({
            title: document.querySelector('[data-testid="mylearning-detail"] h1')?.textContent?.trim() || '',
            bodyText: document.querySelector('[data-testid="mylearning-detail"]')?.textContent?.trim().slice(0, 3200) || '',
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
            horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            height: document.documentElement.scrollHeight,
          }));
          const detailFile = `course-detail-${width}.png`;
          await page.screenshot({ path: path.join(output, detailFile), fullPage: true });
          report.pages.push({ name: 'course-detail', route: '/learning?selected', width, file: detailFile, ...detailMetrics });
        }
      }
    } catch (error) {
      report.errors.push({ type: 'capture', name, route, width, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (admin?.token) {
    try {
      await page.goto(`${base}/admin/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.locator('[data-testid="admin-page-dashboard"]').waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForTimeout(700);
      const file = `admin-dashboard-${width}.png`;
      await page.screenshot({ path: path.join(output, file), fullPage: true });
      const metrics = await page.evaluate(() => ({
        title: document.querySelector('h1')?.textContent?.trim() || '',
        bodyText: document.body.innerText.slice(0, 2400),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        height: document.documentElement.scrollHeight,
      }));
      report.pages.push({ name: 'admin-dashboard', route: '/admin/dashboard', width, file, ...metrics });
    } catch (error) {
      report.errors.push({ type: 'capture', name: 'admin-dashboard', width, message: error instanceof Error ? error.message : String(error) });
    }
  }
  await context.close();
}

report.status = report.errors.length || report.pages.some((entry) => entry.horizontalOverflow > 2) ? 'FAIL' : 'PASS';
await writeFile(path.join(output, 'baseline-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ status: report.status, pages: report.pages.length, errors: report.errors.length, output }, null, 2));
await browser.close();
if (report.status === 'FAIL') process.exitCode = 1;
