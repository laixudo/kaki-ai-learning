import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5174';
const state = JSON.parse(readFileSync('C:/Users/wuzbo/kimi-closeout-02/tools/graph04_state.json', 'utf-8'));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);
await page.goto(`${BASE}/resources`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.screenshot({ path: process.argv[2] || 'C:/Users/wuzbo/kimi-closeout-02/tools/audit04/12_resources_before.png', fullPage: true });
console.log('url:', page.url());
await browser.close();
