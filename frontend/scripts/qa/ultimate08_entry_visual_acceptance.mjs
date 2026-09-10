import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
const out = process.env.KAKI_EVIDENCE || 'evidence/ultimate08-entry';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const bootstrap = await browser.newContext();
const stamp = Date.now();
const registration = await bootstrap.request.post(`${base}/api/auth/register`, {
  data: { username: `ultimate08_entry_${stamp}`, password: 'Ultimate08!2026', email: `ultimate08_${stamp}@example.test` },
});
if (!registration.ok()) throw new Error(`registration HTTP ${registration.status()}`);
const registered = (await registration.json()).data;
const headers = { Authorization: `Bearer ${registered.token}` };
const started = await bootstrap.request.post(`${base}/api/profile-onboarding/start`, { headers });
const taskId = (await started.json()).data.task_id;
await bootstrap.request.post(`${base}/api/profile-onboarding/skip`, { headers, data: { task_id: taskId } });
await bootstrap.close();

const failures = [];
for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(({ token, userId, username }) => {
    const user = { userId, username, hasProfile: true };
    for (const key of ['token', 'auth_token', 'ml_auth_token']) localStorage.setItem(key, token);
    localStorage.setItem('kaki_user', JSON.stringify(user));
    localStorage.setItem('ml_current_user_id', String(userId));
    localStorage.setItem('kaki_profile_status', 'complete');
  }, { token: registered.token, userId: registered.user_id, username: registered.username });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
  await page.locator('#adventureEntry').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(800);
  const result = await page.evaluate(() => {
    const entry = document.querySelector('#adventureEntry');
    const image = entry?.querySelector('.adventure-entry-scene');
    const rect = entry?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      entryWidth: rect?.width || 0,
      entryHeight: rect?.height || 0,
      imageLoaded: Boolean(image?.complete && image?.naturalWidth > 0),
      visibleCopy: entry?.innerText || '',
      fakeMarkCount: entry?.querySelectorAll('.adventure-entry-mark').length || 0,
    };
  });
  if (result.overflow > 1 || !result.imageLoaded || result.fakeMarkCount || !/进入旅程/.test(result.visibleCopy) || consoleErrors.length) {
    failures.push({ viewport, result, consoleErrors });
  }
  await page.screenshot({ path: `${out}/adventure-entry-${viewport.width}.png`, fullPage: true });
  console.log(JSON.stringify({ viewport, result, consoleErrors }));
  await context.close();
}

await browser.close();
if (failures.length) {
  console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS' }));
