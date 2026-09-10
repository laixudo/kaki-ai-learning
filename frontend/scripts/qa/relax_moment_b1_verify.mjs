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

// --- Pass 1: normal motion, real audio, interactive fireworks ---
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(60_000);
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
await page.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);
await page.goto(`${BASE}/ai-learning`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

await page.getByTestId('relax-moment-trigger').click();
const overlay = page.getByTestId('relax-moment-overlay');
await overlay.waitFor({ state: 'visible' });
check('overlay opens', true);

// canvas actually paints warm-gold pixels (not a black/empty canvas)
await page.waitForTimeout(2500);
const painted = await page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="relax-moment-overlay"] canvas');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let warm = 0;
  for (let i = 0; i < data.length; i += 400) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a > 40 && r > 150 && g > 90 && b < 200 && r >= b) warm += 1;
  }
  return warm;
});
check('canvas paints warm gold particles', painted > 30, `warmSamples=${painted}`);

const audioState = await page.evaluate(() => window.KakiAudioManager?.getState());
check('real audio playing relax_fireworks', audioState?.type === 'relax_fireworks' && audioState.paused === false, JSON.stringify(audioState));
check('no AI-template copy', !(await overlay.innerText()).includes('AI 建议'));
check('click hint in motion mode', (await overlay.innerText()).includes('点击夜空'));
await page.screenshot({ path: `${OUT}/17_relax_fireworks.png` });

// click adds a rocket — canvas keeps repainting
await page.mouse.click(800, 300);
await page.waitForTimeout(800);
const painted2 = await page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="relax-moment-overlay"] canvas');
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 400) if (data[i] > 40) n += 1;
  return n;
});
check('click spawns new burst', painted2 > 30, `samples=${painted2}`);

// natural end: audio ends -> finished actions appear
await page.getByRole('button', { name: '再看一会' }).waitFor({ state: 'visible', timeout: 40000 });
check('natural end offers 再看一会/继续学习', true);
await page.screenshot({ path: `${OUT}/17_relax_finished.png` });
await page.getByRole('button', { name: '继续学习' }).click();
await page.waitForTimeout(800);
check('overlay closes via 继续学习', (await page.getByTestId('relax-moment-overlay').count()) === 0);
const stopped = await page.evaluate(() => window.KakiAudioManager?.getState());
check('audio stopped after close', stopped?.type == null && stopped?.paused === true);
await page.close();

// --- Pass 2: reduced motion ---
const reducedPage = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
await reducedPage.addInitScript((token) => { localStorage.setItem('token', token); }, state.token);
await reducedPage.goto(`${BASE}/ai-learning`, { waitUntil: 'domcontentloaded' });
await reducedPage.waitForTimeout(4500);
await reducedPage.getByTestId('relax-moment-trigger').click();
await reducedPage.getByTestId('relax-moment-overlay').waitFor({ state: 'visible' });
await reducedPage.waitForTimeout(1200);
const reducedText = await reducedPage.getByTestId('relax-moment-overlay').innerText();
check('reduced-motion copy shown', reducedText.includes('减少动效'));
check('reduced-motion hides click hint', !reducedText.includes('点击夜空'));
const reducedPainted = await reducedPage.evaluate(() => {
  const canvas = document.querySelector('[data-testid="relax-moment-overlay"] canvas');
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 400) if (data[i] > 40) n += 1;
  return n;
});
check('reduced-motion still paints static fireworks', reducedPainted > 20, `samples=${reducedPainted}`);
await reducedPage.screenshot({ path: `${OUT}/17_relax_reduced.png` });
await reducedPage.getByRole('button', { name: '结束轻松一下' }).click();
await reducedPage.close();

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
