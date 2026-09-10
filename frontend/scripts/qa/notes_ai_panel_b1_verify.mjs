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
page.setDefaultTimeout(90_000);
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);

await page.goto(`${BASE}/notes`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// 1. Create a real note with photography content
await page.getByRole('button', { name: '新建笔记' }).first().click();
await page.waitForTimeout(2500);
await page.locator('textarea').fill('今天学了测光模式。评价测光适合大多数场景，点测光适合逆光人像。逆光拍剪影要对天空测光，人物会欠曝变成剪影。手动档要同时考虑光圈快门感光度。');
await page.waitForTimeout(2500); // autosave

// 2. Trigger a real AI action (polish) — sidebar button
await page.getByRole('button', { name: '润色整理' }).click();
const busy = page.locator('[data-testid="note-ai-busy"]');
check('busy indicator near editor', await busy.isVisible());

// 3. Wait for real LLM result panel near editor (not sidebar)
const panel = page.locator('[data-testid="note-ai-result"]');
await panel.waitFor({ state: 'visible', timeout: 90_000 });
check('result panel visible', true);
const panelBox = await panel.boundingBox();
const editorBox = await page.locator('main textarea').boundingBox();
check('panel is in editor column', Boolean(panelBox && editorBox && Math.abs(panelBox.x - editorBox.x) < 80), `panel.x=${panelBox?.x} editor.x=${editorBox?.x}`);
const headerText = await panel.locator('strong').innerText();
check('header says what was done', headerText.includes('柿小吉帮你做了'), headerText);
check('no raw action_type in header', !/expand|polish|replace_content/.test(headerText), headerText);

const preview = await page.locator('[data-testid="note-ai-preview"]').innerText();
check('preview has real content', preview.length > 40, `len=${preview.length}`);
check('preview differs from original', !preview.includes('今天学了测光模式。评价测光适合大多数场景'));
await page.screenshot({ path: `${OUT}/13_notes_result_panel.png` });

// 4. Insert at cursor: place cursor at start, insert
await page.locator('main textarea').click({ position: { x: 20, y: 10 } });
await page.locator('main textarea').evaluate((el) => { el.setSelectionRange(0, 0); el.focus(); });
const before = await page.locator('main textarea').inputValue();
await page.locator('[data-testid="note-ai-insert"]').click();
await page.waitForTimeout(1500);
const after = await page.locator('main textarea').inputValue();
check('insert at cursor prepends suggestion', after.startsWith(preview.slice(0, 20)) && after.includes(before.slice(0, 20)));
check('suggestion stays open after insert', await panel.isVisible());

// 5. Close dismisses suggestion
await page.locator('[data-testid="note-ai-close"]').click();
await page.waitForTimeout(1500);
check('panel closed after dismiss', (await page.locator('[data-testid="note-ai-result"]').count()) === 0);

// 6. Second run: summarize -> 保留原文并追加
await page.getByRole('button', { name: '生成摘要' }).click();
await panel.waitFor({ state: 'visible', timeout: 90_000 });
const appendBtn = page.locator('[data-testid="note-ai-append"]');
check('append mode offers 保留原文并追加', await appendBtn.isVisible());
const contentBeforeAppend = await page.locator('main textarea').inputValue();
await appendBtn.click();
await page.waitForTimeout(2500);
const contentAfterAppend = await page.locator('main textarea').inputValue();
check('append keeps original text', contentAfterAppend.includes(contentBeforeAppend.slice(0, 30)));
check('append grew content', contentAfterAppend.length > contentBeforeAppend.length);
await page.screenshot({ path: `${OUT}/13_notes_after_append.png` });

// 7. Sidebar no longer hosts the result (no nested-scroll suggestion box)
check('sidebar has no suggestion box', (await page.locator('.aiSuggestion').count()) === 0);

// 8. Cleanup: delete the test note
await page.locator('main button.ant-btn-dangerous').first().click();
await page.waitForTimeout(600);
await page.locator('.ant-popconfirm button.ant-btn-primary, .ant-popover button:has-text("删除")').first().click();
await page.waitForTimeout(2000);
console.log('cleanup done, url:', page.url());

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
