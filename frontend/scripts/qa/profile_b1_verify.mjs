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

await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const body = await page.locator('body').innerText();

// 1. New product identity
check('identity: 柿小吉眼中的你', body.includes('柿小吉眼中的你'));
check('identity: 柿小吉的印象', body.includes('柿小吉的印象'));
check('identity: 最近的学习足迹', body.includes('最近的学习足迹'));
check('identity: 能力全景 ten dims', body.includes('能力全景'));
check('impression fallback is warm', body.includes('柿小吉还在观察你的学习方式'));

// 2. Engineering language eliminated
const banned = ['waiting-for-first-action', '画像版本', '置信度', '趋势待积累', '证据不足', '来源：', '实时学习信号', 'Agent 协作', '动态与下一条证据', '去留下证据', '根据后端画像', '画像确认度', '后端画像推荐', '预填分数。\'', '未采集项'];
for (const word of banned) {
  check(`no engineering term: ${word}`, !body.includes(word));
}

// 3. KPI strip relabeled
check('KPI 综合能力', body.includes('综合能力'));
check('KPI 了解程度', body.includes('了解程度'));

// 4. Progressive empty states (this user has almost no evidence)
check('dimension list present', (await page.locator('[data-profile-dimension]').count()) === 10);
check('radar shows 积累中 not 0', body.includes('积累中'));
check('next-step suggestion warm', body.includes('下一步建议'));
check('preference empty warm', body.includes('柿小吉还没有足够依据'));
check('weak points empty warm', body.includes('最需要加强的地方'));
check('suggestions empty warm', body.includes('柿小吉还在收集依据'));

// 5. Duplicate behavior-summary row removed
check('no duplicate dimension bars row', (await page.locator('[class*="profileBehaviorSummary"]').count()) === 0);

await page.screenshot({ path: `${OUT}/14_profile_after.png`, fullPage: true });

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
