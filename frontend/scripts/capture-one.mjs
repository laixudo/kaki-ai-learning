// 单页截图辅助:node scripts/capture-one.mjs <path> <name> [waitMs]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const [, , route = '/ai-learning', name = 'page', waitMs = '3500'] = process.argv;
const BASE = 'http://127.0.0.1:5174';
const OUT = new URL('../.captures/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/login`);
await page.fill('input[type="text"]', 'smoketest_user');
await page.fill('input[type="password"]', 'Smoke@Test123');
await page.click('button[type="submit"], button:has-text("登录")');
await page.waitForTimeout(2200);
await page.goto(`${BASE}${route}`);
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: `${OUT}${name}.png` });
console.log('saved:', `${OUT}${name}.png`);
console.log('console errors:', errors.length ? errors.join('\n') : '(none)');
await browser.close();
