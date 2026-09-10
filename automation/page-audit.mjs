import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const requireFromFrontend = createRequire(path.join(projectRoot, 'frontend', 'package.json'));
const { chromium } = requireFromFrontend('@playwright/test');
const baseUrl = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
const username = process.env.KAKI_AUDIT_USER || '数据学习员';
const password = process.env.KAKI_AUDIT_PASSWORD || 'KakiShowcase!2026';
const outputDir = path.join(projectRoot, 'output', 'demo-video', 'audit');

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const login = await context.request.post(`${baseUrl}/api/auth/login`, { data: { username, password } });
if (!login.ok()) throw new Error(`audit login failed: ${login.status()} ${await login.text()}`);
const auth = (await login.json()).data;
await context.addInitScript(({ token, userId, user }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('ml_current_user_id', String(userId));
  localStorage.setItem('kaki_user', JSON.stringify({ userId, username: user, hasProfile: true }));
}, { token: auth.token, userId: auth.user_id, user: auth.username });

const page = await context.newPage();
page.setDefaultTimeout(30_000);
const consoleErrors = [];
const failedRequests = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText}`));

const routes = [
  ['ai-learning', '/ai-learning'],
  ['learning', '/learning'],
  ['resources', '/resources'],
  ['notes', '/notes'],
  ['artifacts', '/artifacts'],
  ['video', '/video'],
  ['exam', '/exam'],
  ['profile', '/profile'],
];
const report = [];
for (const [name, route] of routes) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(name === 'ai-learning' ? 4_500 : 2_500);
  const state = await page.locator('body').evaluate((body) => ({
    title: document.title,
    headings: Array.from(body.querySelectorAll('h1,h2,h3')).map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 30),
    buttons: Array.from(body.querySelectorAll('button')).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).map((node) => node.textContent?.trim() || node.getAttribute('aria-label')).filter(Boolean).slice(0, 60),
    text: body.innerText.replace(/\s+/g, ' ').trim().slice(0, 1800),
  }));
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: false });
  report.push({ name, route, url: page.url(), ...state });
}

await writeFile(path.join(outputDir, 'page-audit.json'), `${JSON.stringify({ report, consoleErrors, failedRequests }, null, 2)}\n`, 'utf8');
await context.close();
await browser.close();
console.log(JSON.stringify({ pages: report.map(({ name, url, headings, buttons }) => ({ name, url, headings, buttons })), consoleErrors, failedRequests }, null, 2));
