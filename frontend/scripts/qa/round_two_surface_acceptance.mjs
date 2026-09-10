import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.SHIGUANG_FRONTEND || 'http://127.0.0.1:5174';
const userToken = process.env.SHIGUANG_USER_TOKEN;
const adminToken = process.env.SHIGUANG_ADMIN_TOKEN;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.env.SHIGUANG_EVIDENCE || path.join(repoRoot, 'evidence/shiguang-manyou-20260718');
if (!userToken || !adminToken) throw new Error('SHIGUANG_USER_TOKEN and SHIGUANG_ADMIN_TOKEN are required');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const forbiddenRequests = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });
page.on('request', (request) => { if (/127\.0\.0\.1:(8000|8765)/.test(request.url())) forbiddenRequests.push(request.url()); });

await page.addInitScript(({ user, admin }) => {
  localStorage.setItem('token', user);
  localStorage.setItem('auth_token', user);
  localStorage.setItem('ml_auth_token', user);
  localStorage.setItem('kaki_user', JSON.stringify({ userId: 3, username: 'browsertest', hasProfile: true }));
  localStorage.setItem('ml_current_user_id', '3');
  localStorage.setItem('kaki_profile_status', 'complete');
  localStorage.setItem('admin_token', admin);
  localStorage.setItem('admin_role', 'admin');
  localStorage.setItem('admin_user', JSON.stringify({ account: 'admin', role: 'admin', name: 'Admin' }));
}, { user: userToken, admin: adminToken });

const open = async (route, ready) => {
  await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
  try {
    await page.locator(ready).waitFor({ state: 'visible' });
  } catch (error) {
    console.error(JSON.stringify({ route, url: page.url(), body: (await page.locator('body').innerText()).slice(0, 1200), consoleErrors, pageErrors, failedResponses }, null, 2));
    throw error;
  }
  await page.waitForTimeout(300);
};
const layout = () => page.evaluate(() => ({
  viewport: document.documentElement.clientWidth,
  pageWidth: document.documentElement.scrollWidth,
  horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
}));

await open('/resources', '[data-testid="module-page-resources"]');
const resources = {
  layout: await layout(),
  recommendationCards: await page.locator('[data-testid="profile-resource-recommendations"] button').count(),
  insufficientState: await page.locator('[data-testid="profile-resource-insufficient"]').count(),
  tableScroll: await page.evaluate(() => {
    const node = document.querySelector('.ant-table-content');
    return node ? { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, internalOverflow: node.scrollWidth > node.clientWidth } : null;
  })
};
await page.screenshot({ path: path.join(output, 'after-resources-profile-recommendations.png'), fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(200);
resources.responsiveLayout = await layout();
await page.screenshot({ path: path.join(output, 'after-resources-1280.png'), fullPage: true });
await page.setViewportSize({ width: 1600, height: 1000 });

await open('/exam', '[data-testid="module-page-exam"]');
const exam = {
  layout: await layout(),
  alignment: await page.evaluate(() => {
    const left = Array.from(document.querySelectorAll('[class*="examLeft"] > *')).map((node) => node.getBoundingClientRect());
    const right = Array.from(document.querySelectorAll('[class*="examRight"] > *')).map((node) => node.getBoundingClientRect());
    const summary = document.querySelector('[class*="examPlanSummary"]')?.getBoundingClientRect();
    return {
      leftCards: left.length,
      rightCards: right.length,
      firstRowTopDelta: left[0] && right[0] ? Math.abs(left[0].top - right[0].top) : null,
      leftColumnWidth: left[0]?.width ?? null,
      rightColumnWidth: right[0]?.width ?? null,
      planSummary: summary ? { width: summary.width, height: summary.height, top: summary.top, bottom: summary.bottom } : null
    };
  })
};
await page.screenshot({ path: path.join(output, 'after-exam-card-alignment.png'), fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(200);
exam.responsiveLayout = await layout();
await page.screenshot({ path: path.join(output, 'after-exam-card-alignment-1280.png'), fullPage: true });
await page.setViewportSize({ width: 1600, height: 1000 });

await open('/profile', '[data-testid="profile-ten-dimensions"]');
const profile = {
  layout: await layout(),
  dimensions: await page.locator('[data-profile-dimension]').count(),
  evidenceStates: await page.locator('[data-profile-dimension]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-evidence'))),
  insufficientLabels: await page.getByText('数据积累中', { exact: true }).count()
};
await page.screenshot({ path: path.join(output, 'after-profile-ten-dimensions.png'), fullPage: true });

await open('/admin/dashboard', '[data-testid="admin-brand-overview"]');
const admin = {
  layout: await layout(),
  brandOverview: await page.locator('[data-testid="admin-brand-overview"]').count(),
  dashboardTextLength: (await page.locator('[data-testid="admin-page-dashboard"]').innerText()).length
};
await page.screenshot({ path: path.join(output, 'after-admin-brand-dashboard.png'), fullPage: true });

const report = {
  status: consoleErrors.length || pageErrors.length || failedResponses.length || forbiddenRequests.length ||
    resources.layout.horizontalOverflow > 2 || resources.responsiveLayout.horizontalOverflow > 2 || resources.recommendationCards < 3 ||
    exam.layout.horizontalOverflow > 2 || exam.responsiveLayout.horizontalOverflow > 2 || exam.alignment.firstRowTopDelta == null || exam.alignment.firstRowTopDelta > 2 || !exam.alignment.planSummary || exam.alignment.planSummary.height < 100 ||
    profile.dimensions !== 10 || admin.brandOverview !== 1
    ? 'FAIL' : 'PASS',
  base,
  resources,
  exam,
  profile,
  admin,
  consoleErrors,
  pageErrors,
  failedResponses,
  forbiddenRequests,
  screenshots: [
    path.join(output, 'after-resources-profile-recommendations.png'),
    path.join(output, 'after-resources-1280.png'),
    path.join(output, 'after-exam-card-alignment.png'),
    path.join(output, 'after-exam-card-alignment-1280.png'),
    path.join(output, 'after-profile-ten-dimensions.png'),
    path.join(output, 'after-admin-brand-dashboard.png')
  ]
};
await writeFile(path.join(output, 'round-two-surface-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
await browser.close();
