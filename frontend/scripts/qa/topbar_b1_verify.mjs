import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5174';
const OUT = 'C:/Users/wuzbo/kimi-closeout-02/tools/audit04';
const state = JSON.parse(readFileSync('C:/Users/wuzbo/kimi-closeout-02/tools/graph04_state.json', 'utf-8'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(60_000);
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);

await page.goto(`${BASE}/learning`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

// 1. Topbar structure: search / bell / user chip, no standalone 退出 button
const topbar = page.getByTestId('app-topbar');
check('topbar visible', await topbar.isVisible());
check('search input present', await page.getByTestId('global-search-input').isVisible());
check('bell present', await page.getByTestId('global-message-button').isVisible());
check('user chip present', await page.getByTestId('global-user-menu-button').isVisible());
check('no standalone logout button', (await topbar.locator('button:has-text("退出")').count()) === 0);

// 2. Alignment: all topbar controls vertically centered on one line
const boxes = await Promise.all([
  page.getByTestId('global-search-input').boundingBox(),
  page.getByTestId('global-message-button').boundingBox(),
  page.getByTestId('global-user-menu-button').boundingBox(),
]);
const centers = boxes.filter(Boolean).map(b => b.y + b.height / 2);
check('controls share one baseline', Math.max(...centers) - Math.min(...centers) < 12, centers.map(c => c.toFixed(0)).join(','));

// 3. User menu: opens, contains 退出登录, closes on outside click
await page.getByTestId('global-user-menu-button').click();
await page.waitForTimeout(400);
const panel = page.getByTestId('global-user-panel');
check('user panel opens', await panel.isVisible());
check('logout inside user menu', await page.getByTestId('global-logout-button').isVisible());
check('profile link preserved', await page.getByTestId('global-user-profile-link').isVisible());
await page.screenshot({ path: `${OUT}/16_topbar_user_menu.png` });
await page.mouse.click(700, 500);
await page.waitForTimeout(400);
check('panel closes on outside click', (await page.getByTestId('global-user-panel').count()) === 0);

// 4. Message panel opens and Esc closes it
await page.getByTestId('global-message-button').click();
await page.waitForTimeout(1200);
check('message panel opens', await page.getByTestId('global-message-panel').isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('message panel closes on Esc', (await page.getByTestId('global-message-panel').count()) === 0);

// 5. Real search round-trip (de-engineered copy)
await page.getByTestId('global-search-input').fill('测光');
await page.getByTestId('global-search-input').press('Enter');
await page.waitForTimeout(4000);
const searchPanel = page.getByTestId('global-search-results');
check('search panel opens', await searchPanel.isVisible());
const searchText = await searchPanel.innerText();
check('no 后端 copy in search', !searchText.includes('后端'));
await page.keyboard.press('Escape');

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
