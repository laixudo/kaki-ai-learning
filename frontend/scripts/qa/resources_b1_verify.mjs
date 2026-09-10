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
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);

await page.goto(`${BASE}/resources`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

// 1. Empty state: upload CTA visible, no table frame
check('upload CTA visible', await page.locator('[data-testid="material-upload-cta"]').isVisible());
check('no antd table frame', (await page.locator('.ant-table').count()) === 0);
check('empty state visible', await page.locator('[data-testid="material-empty"]').isVisible());

// 2. Real upload through the UI
await page.locator('input[type="file"][hidden]').setInputFiles('C:/Users/wuzbo/kimi-closeout-02/tools/fixtures/photo_notes.md');
await page.waitForTimeout(6000);
const list = page.locator('[data-testid="material-list"]');
check('list appears after upload', await list.isVisible());
const listText = await list.innerText();
check('uploaded file in list', listText.includes('photo_notes.md'));
check('status tag shown', /可使用|解析中/.test(listText));

// 3. Toolbar appears once materials exist
check('toolbar search present', await page.getByPlaceholder('搜索资料名称、分类或内容').isVisible());

// 4. Detail modal opens with structure
await page.getByLabel('查看photo_notes.md').click();
await page.waitForTimeout(2000);
const modal = page.locator('.ant-modal');
check('detail modal opens', await modal.isVisible());
const modalText = await modal.innerText();
check('detail has preview or structure', modalText.includes('顺光') || modalText.includes('内容结构'));
check('no engineering ID line', !modalText.includes('ID'));
await page.screenshot({ path: `${OUT}/12_resources_detail.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// 5. Search filters the list server-side
await page.getByPlaceholder('搜索资料名称、分类或内容').fill('不存在的资料名');
await page.waitForTimeout(2500);
check('filtered empty state', await page.locator('[data-testid="material-empty"]').isVisible());
check('clear filter button', (await page.locator('[data-testid="material-empty"]').innerText()).includes('清除筛选'));
await page.getByRole('button', { name: '清除筛选' }).click();
await page.waitForTimeout(2500);
check('list restored after clear', await page.locator('[data-testid="material-list"]').isVisible());

await page.screenshot({ path: `${OUT}/12_resources_after_list.png`, fullPage: true });

// 6. Clean up: delete the uploaded material
await page.getByLabel('删除photo_notes.md').click();
await page.waitForTimeout(800);
await page.locator('.ant-modal .ant-btn-dangerous, .ant-modal button:has-text("删除")').last().click();
await page.waitForTimeout(3000);
check('material deleted, empty state back', await page.locator('[data-testid="material-empty"]').isVisible());

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
