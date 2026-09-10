import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.FINAL_FRONTEND || 'http://127.0.0.1:5174';
const userToken = process.env.FINAL_USER_TOKEN;
const adminToken = process.env.FINAL_ADMIN_TOKEN;
const userId = process.env.FINAL_USER_ID;
if (!userToken || !adminToken || !userId) throw new Error('FINAL_USER_TOKEN, FINAL_ADMIN_TOKEN and FINAL_USER_ID are required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.join(root, 'evidence/final-impact-closeout');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [], pageErrors = [], failedResponses = [], forbiddenRequests = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => pageErrors.push(e.message));
page.on('response', r => { if (r.status() >= 400) failedResponses.push({ status: r.status(), url: r.url() }); });
page.on('request', r => { if (/127\.0\.0\.1:(8000|8765)/.test(r.url())) forbiddenRequests.push(r.url()); });
await page.addInitScript(({ userToken, adminToken, userId }) => {
  localStorage.setItem('token', userToken); localStorage.setItem('auth_token', userToken); localStorage.setItem('ml_auth_token', userToken);
  localStorage.setItem('ml_current_user_id', userId); localStorage.setItem('kaki_profile_status', 'complete');
  localStorage.setItem('kaki_user', JSON.stringify({ userId: Number(userId), username: 'final-acceptance', hasProfile: true }));
  localStorage.setItem('admin_token', adminToken); localStorage.setItem('admin_role', 'admin');
}, { userToken, adminToken, userId });

const itemsResponse = await page.request.get(`${base}/api/items/list`, { headers: { Authorization: `Bearer ${userToken}` } });
if (!itemsResponse.ok()) throw new Error(`items list ${itemsResponse.status()}`);
const itemsBody = await itemsResponse.json();
const items = itemsBody.data || [];
const artifact = items.find(item => /^workspace_(presentation|interactive_lesson|mindmap|code|lecture)$/.test(item.type)) || items[0];
if (!artifact) throw new Error('No real artifact available for acceptance');

await page.goto(`${base}/artifacts/${artifact.id}`, { waitUntil: 'networkidle' });
await page.locator('[data-testid="unified-artifact-detail"]').waitFor();
const artifactResult = {
  id: artifact.id, type: artifact.type,
  title: await page.locator('h1').first().innerText(),
  renderedTextLength: (await page.locator('[data-testid="unified-artifact-detail"]').innerText()).length,
  exportButtons: await page.getByRole('button', { name: /导出/ }).count(),
  horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
};
await page.screenshot({ path: path.join(output, 'unified-artifact-detail.png'), fullPage: true });

await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
await page.locator('#apiSwitch').waitFor();
const aiConfig = {
  entry: await page.locator('#apiSwitch').count(),
  defaultProvider: await page.locator('#runtimeProvider').inputValue(),
  defaultModel: await page.locator('#runtimeModel').inputValue(),
};

await page.goto(`${base}/resources`, { waitUntil: 'networkidle' });
await page.locator('[data-testid="real-material-library"]').waitFor();
const resources = {
  rows: await page.locator('[data-testid="real-material-library"] tbody tr').count(),
  realUpload: await page.getByRole('button', { name: '上传真实资料' }).count(),
  downloadActions: await page.getByRole('button', { name: /^下载/ }).count(),
  horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
};
await page.screenshot({ path: path.join(output, 'real-material-library.png'), fullPage: true });

await page.goto(`${base}/admin/operations`, { waitUntil: 'networkidle' });
await page.getByText('24h 调用', { exact: true }).waitFor();
const operations = { rows: await page.locator('tbody tr').count(), compactMetrics: await page.locator('[aria-label="24小时运营指标"] > div').count(), text: (await page.locator('main').innerText()).slice(0, 1200) };
await page.screenshot({ path: path.join(output, 'admin-operations-truth.png'), fullPage: true });

await page.goto(`${base}/admin/system`, { waitUntil: 'networkidle' });
await page.getByText('系统配置', { exact: true }).click();
await page.getByText('安全配置概览', { exact: true }).waitFor();
const system = {
  hasReadOnly: await page.getByText('只读', { exact: true }).count(),
  hasEnvEditor: await page.getByText('编辑系统配置', { exact: true }).count(),
  hasMaskedKey: await page.getByText('API Key', { exact: true }).count(),
};
await page.screenshot({ path: path.join(output, 'admin-safe-config.png'), fullPage: true });

const report = {
  status: artifactResult.renderedTextLength > 80 && artifactResult.exportButtons > 0 && artifactResult.horizontalOverflow <= 2 && aiConfig.entry === 1 && aiConfig.defaultProvider === 'deepseek' && resources.rows > 0 && resources.realUpload === 1 && resources.downloadActions > 0 && resources.horizontalOverflow <= 2 && operations.rows > 0 && operations.compactMetrics === 5 && system.hasReadOnly > 0 && system.hasEnvEditor === 0 && system.hasMaskedKey > 0 && !consoleErrors.length && !pageErrors.length && !failedResponses.length && !forbiddenRequests.length ? 'PASS' : 'FAIL',
  artifact: artifactResult, aiConfig, resources, operations, system, consoleErrors, pageErrors, failedResponses, forbiddenRequests,
  screenshots: [path.join(output, 'unified-artifact-detail.png'), path.join(output, 'real-material-library.png'), path.join(output, 'admin-operations-truth.png'), path.join(output, 'admin-safe-config.png')],
};
await writeFile(path.join(output, 'final-impact-closeout-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
