import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5174';
const OUT = 'C:/Users/wuzbo/kimi-closeout-02/tools/audit04';
const state = JSON.parse(readFileSync('C:/Users/wuzbo/kimi-closeout-02/tools/graph04_state.json', 'utf-8'));

const pages = [
  ['dashboard', '/'],
  ['ai-learning', '/ai-learning'],
  ['learning', '/learning'],
  ['resources', '/resources'],
  ['notes', '/notes'],
  ['artifacts', '/artifacts'],
  ['exam', '/exam'],
  ['profile', '/profile'],
];

const width = Number(process.env.SWEEP_WIDTH || 1600);
const tag = width === 1600 ? '' : `_${width}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height: 1000 } });
page.setDefaultTimeout(60_000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);

for (const [name, path] of pages) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4200);
  await page.screenshot({ path: `${OUT}/sweep${tag}_${name}.png`, fullPage: false });
  console.log(`[SHOT] ${name}${tag}`);
}
// horizontal overflow check
for (const [name, path] of pages) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`${overflow > 4 ? '[FAIL]' : '[PASS]'} no horizontal overflow: ${name} (${overflow}px)`);
}
console.log('pageerrors:', errors.length ? errors : 'none');
await browser.close();
