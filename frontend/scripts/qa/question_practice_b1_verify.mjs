import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5174';
const OUT = process.argv[2] || 'C:/Users/wuzbo/kimi-closeout-02/tools/audit04/practice';
const state = JSON.parse(readFileSync('C:/Users/wuzbo/kimi-closeout-02/tools/graph04_state.json', 'utf-8'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR:', m.text().slice(0, 200)); });
await page.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);

await page.goto(`${BASE}/artifacts/8`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// 1. Intro card
const intro = page.locator('[data-testid="question-practice-intro"]');
check('intro card shown', await intro.isVisible());
check('intro honest note', (await intro.innerText()).includes('不会写入你的学习档案'));
await page.screenshot({ path: `${OUT}-01-intro.png` });

// 2. Start practice -> Q1 choice (correct answer C)
await page.locator('[data-testid="practice-start"]').click();
const renderer = page.locator('[data-testid="question-practice-renderer"]');
check('renderer shown', await renderer.isVisible());
check('q1 stem is photography', (await renderer.innerText()).includes('剪影'));

// wrong answer first: option B (index 1), correct is C (index 2)
await page.locator('[data-testid="practice-option"]').nth(1).click();
await page.locator('[data-testid="practice-submit"]').click();
await page.waitForTimeout(400);
let feedback = page.locator('[data-testid="practice-feedback"]');
check('wrong feedback shown', await feedback.isVisible());
check('wrong feedback text', (await feedback.innerText()).includes('这次还不对'));
await page.screenshot({ path: `${OUT}-02-wrong.png` });

// retry with correct answer
await page.locator('[data-testid="practice-retry"]').click();
await page.locator('[data-testid="practice-option"]').nth(2).click();
await page.locator('[data-testid="practice-submit"]').click();
await page.waitForTimeout(400);
feedback = page.locator('[data-testid="practice-feedback"]');
check('correct feedback text', (await feedback.innerText()).includes('回答正确'));
check('explanation shown', (await renderer.innerText()).includes('解析'));
await page.screenshot({ path: `${OUT}-03-correct.png` });

// 3. Q2 fill_blank -> text answer -> reference answer shown
await page.getByRole('button', { name: '下一题' }).click();
await page.waitForTimeout(300);
check('q2 fill input', await page.locator('[data-testid="practice-answer-input"]').isVisible());
await page.locator('[data-testid="practice-answer-input"]').fill('f/4 左右的光圈可以兼顾虚化与进光量');
await page.locator('[data-testid="practice-submit"]').click();
await page.waitForTimeout(400);
check('q2 reference answer shown', (await renderer.innerText()).includes('参考答案'));
await page.screenshot({ path: `${OUT}-04-fill-reference.png` });

// 4. Hint button on Q3
await page.getByRole('button', { name: '下一题' }).click();
await page.waitForTimeout(300);
const hintBtn = page.getByRole('button', { name: '给我一点提示' });
check('hint button present', await hintBtn.isVisible());
await hintBtn.click();
check('hint content shown', (await renderer.innerText()).includes('方向提示'));
await page.locator('[data-testid="practice-answer-input"]').fill('import math 然后按公式计算 EV');
await page.locator('[data-testid="practice-submit"]').click();
await page.waitForTimeout(300);

// 5. Q4 case study
await page.getByRole('button', { name: '下一题' }).click();
await page.waitForTimeout(300);
await page.locator('[data-testid="practice-answer-input"]').fill('使用三脚架固定相机，手动模式点测光');
await page.locator('[data-testid="practice-submit"]').click();
await page.waitForTimeout(300);

// 6. Q5 choice (answer B)
await page.getByRole('button', { name: '下一题' }).click();
await page.waitForTimeout(300);
await page.locator('[data-testid="practice-option"]').nth(1).click();
await page.locator('[data-testid="practice-submit"]').click();
await page.waitForTimeout(400);

// 7. Summary
const summary = page.locator('[data-testid="practice-summary"]');
check('summary shown after all submitted', await summary.isVisible());
const summaryText = await summary.innerText();
check('summary score line', /答对 2 \/ 2 道/.test(summaryText), summaryText.replace(/\n/g, ' | ').slice(0, 160));
check('summary honest note', summaryText.includes('不会写入你的学习档案'));
await page.screenshot({ path: `${OUT}-05-summary.png` });

// 8. Kind label de-engineered
check('kind label is 练习题', (await page.locator('[data-testid="artifact-shell"]').innerText()).includes('练习题'));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
