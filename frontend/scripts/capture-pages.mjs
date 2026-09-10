// 逐页截取当前运行页面,用于与视觉目标图对比(仅本地开发辅助,不参与构建)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5174';
const OUT = new URL('../.captures/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(OUT, { recursive: true });

const USER = { username: 'smoketest_user', password: 'Smoke@Test123' };

const pages = [
  { path: '/ai-learning', name: '01_ai_workspace' },
  { path: '/learning', name: '02_my_learning' },
  { path: '/notes', name: '03_notes' },
  { path: '/resources', name: '04_material' },
  { path: '/exam', name: '05_practice' },
  { path: '/video', name: '06_video' },
  { path: '/artifacts', name: '07_artifacts' },
  { path: '/profile', name: '08_profile' },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[${page.url()}] ${msg.text()}`); });
page.on('pageerror', (err) => consoleErrors.push(`[pageerror ${page.url()}] ${err.message}`));

// 登录
await page.goto(`${BASE}/login`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}00_login.png` });
await page.fill('input[type="text"], input#username, input[placeholder*="用户"], input[placeholder*="账号"]', USER.username).catch(() => {});
await page.fill('input[type="password"]', USER.password).catch(() => {});
await page.click('button[type="submit"], button:has-text("登录")').catch(() => {});
await page.waitForTimeout(2500);

// 若跳到 onboarding,尝试跳过
if (page.url().includes('onboarding')) {
  await page.screenshot({ path: `${OUT}00_onboarding.png` });
  for (const label of ['跳过', '稍后', '先跳过', '稍后再说']) {
    const btn = page.locator(`button:has-text("${label}")`).first();
    if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(1500); break; }
  }
}

for (const target of pages) {
  await page.goto(`${BASE}${target.path}`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}${target.name}.png`, fullPage: false });
}

console.log('URL after login flow:', page.url());
console.log('Console errors:', consoleErrors.length ? consoleErrors.join('\n') : '(none)');
await browser.close();
