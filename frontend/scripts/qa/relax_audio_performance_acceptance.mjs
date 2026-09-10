import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.SHIGUANG_FRONTEND || 'http://127.0.0.1:5174';
const username = process.env.SHIGUANG_USER;
const password = process.env.SHIGUANG_PASSWORD || 'Manyou!2026';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.env.SHIGUANG_EVIDENCE || path.join(repoRoot, 'evidence/shiguang-manyou-20260718');
if (!username) throw new Error('SHIGUANG_USER is required');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
const warnings = [];
const pageErrors = [];
const failedResponses = [];
let audioResponse = null;
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => {
  if (response.url().includes('/audio/kaki-fireworks-night.m4a')) audioResponse = { status: response.status(), contentType: response.headers()['content-type'] || '' };
  if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
});

const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
if (!login.ok()) throw new Error(`login returned ${login.status()}`);
const payload = await login.json();
const data = payload.data;
await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { user_id: data.user_id, username: data.username, has_profile: true } }) }));
await page.addInitScript(({ token, userId, user }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify({ userId, username: user, hasProfile: true }));
  localStorage.setItem('ml_current_user_id', String(userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: data.token, userId: data.user_id, user: data.username });

await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
await page.getByTestId('relax-moment-trigger').click();
const overlay = page.getByTestId('relax-moment-overlay');
await overlay.waitFor({ state: 'visible' });
await page.waitForTimeout(500);
const startState = await page.evaluate(() => window.KakiAudioManager?.getState());
const singleton = await page.evaluate(() => {
  const first = window.KakiAudioManager;
  window.__kakiSoundIdentity = first;
  return Boolean(first) && first.types.includes('relax_fireworks') && first.types.includes('celebration');
});

const performanceResult = await page.evaluate(async () => {
  const frameTimes = [];
  const longTasks = [];
  let last = performance.now();
  const observer = typeof PerformanceObserver !== 'undefined' ? new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  }) : null;
  try { observer?.observe({ type: 'longtask', buffered: false }); } catch (_) {}
  const started = performance.now();
  await new Promise((resolve) => {
    function frame(now) {
      frameTimes.push(now - last);
      last = now;
      if (now - started < 6000) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
    const points = [[.28,.28],[.67,.24],[.48,.4],[.76,.34],[.36,.22],[.57,.3]];
    points.forEach(([x,y], index) => setTimeout(() => {
      const canvas = document.querySelector('[data-testid="relax-moment-overlay"] canvas');
      if (!canvas) return;
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: innerWidth * x, clientY: innerHeight * y }));
    }, 450 + index * 620));
  });
  observer?.disconnect();
  const sorted = frameTimes.slice(1).sort((a,b) => a-b);
  const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0;
  return {
    samples: sorted.length,
    averageFrameMs: sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length),
    p95FrameMs: percentile(.95),
    p99FrameMs: percentile(.99),
    framesOver34ms: sorted.filter((value) => value > 34).length,
    longTaskCount: longTasks.length,
    maxLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0
  };
});

await page.screenshot({ path: path.join(output, 'after-relax-audio-performance.png'), fullPage: true });
await page.locator('[class*="soundControls"] button').click();
const mutedState = await page.evaluate(() => window.KakiAudioManager?.getState());
await page.locator('[class*="soundControls"] button').click();
await page.getByRole('button', { name: '再看一会' }).waitFor({ state: 'visible', timeout: 32000 });
const naturalEndState = await page.evaluate(() => window.KakiAudioManager?.getState());
await page.screenshot({ path: path.join(output, 'after-relax-natural-end.png'), fullPage: true });
await page.getByRole('button', { name: '再看一会' }).click();
await page.waitForTimeout(450);
const restartedState = await page.evaluate(() => window.KakiAudioManager?.getState());
const reusedSingleton = await page.evaluate(() => window.__kakiSoundIdentity === window.KakiAudioManager);
await page.getByRole('button', { name: '结束轻松一下' }).click();
await page.waitForTimeout(650);
const stoppedState = await page.evaluate(() => window.KakiAudioManager?.getState());

const report = {
  status: singleton && reusedSingleton && startState?.type === 'relax_fireworks' && startState.volume <= .35 && mutedState?.muted === true &&
    naturalEndState?.type == null && naturalEndState?.ended === true && restartedState?.type === 'relax_fireworks' &&
    stoppedState?.type == null && stoppedState?.paused === true && stoppedState.currentTime === 0 &&
    performanceResult.averageFrameMs < 20 && performanceResult.p95FrameMs <= 34 && performanceResult.framesOver34ms <= 3 && performanceResult.longTaskCount <= 1 &&
    !consoleErrors.length && !pageErrors.length && !failedResponses.length ? 'PASS' : 'FAIL',
  audioResponse,
  startState,
  mutedState,
  naturalEndState,
  restartedState,
  stoppedState,
  singleton,
  reusedSingleton,
  performance: performanceResult,
  consoleErrors,
  warnings,
  pageErrors,
  failedResponses,
  screenshot: path.join(output, 'after-relax-audio-performance.png')
};
await writeFile(path.join(output, 'relax-audio-performance-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
await browser.close();
