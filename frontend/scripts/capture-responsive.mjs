// 响应式检查:多宽度截图 + 横向溢出检测
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5174';
const OUT = new URL('../.captures/responsive/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(OUT, { recursive: true });

const widths = [1920, 1366, 1024, 768, 390];
const routes = ['/ai-learning', '/learning', '/resources', '/exam', '/notes', '/video'];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`);
await page.fill('input[type="text"]', 'smoketest_user');
await page.fill('input[type="password"]', 'Smoke@Test123');
await page.click('button[type="submit"], button:has-text("登录")');
await page.waitForTimeout(2200);

const overflows = [];
for (const width of widths) {
  await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
  for (const route of routes) {
    await page.goto(`${BASE}${route}`);
    await page.waitForTimeout(2600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) overflows.push(`${width}px ${route}: 横向溢出 ${overflow}px`);
    await page.screenshot({ path: `${OUT}${width}_${route.replace(/\//g, '')}.png` });
  }
}
console.log(overflows.length ? overflows.join('\n') : '所有宽度无横向溢出');
await browser.close();
