import { chromium } from '@playwright/test';

const base = process.env.FINAL06_BASE_URL || 'http://127.0.0.1:5174';
const token = process.env.FINAL06_USER_TOKEN;
if (!token) throw new Error('FINAL06_USER_TOKEN is required');

const browser = await chromium.launch({ headless: true });
const identityContext = await browser.newContext();
const meResponse = await identityContext.request.get(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
if (!meResponse.ok()) throw new Error(`Identity failed with HTTP ${meResponse.status()}`);
const identity = (await meResponse.json()).data;
await identityContext.close();

const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await context.addInitScript(({ token: authToken, identity: current }) => {
  const user = { userId: current.user_id, username: current.username, email: null, avatarUrl: current.avatar_url ?? null, hasProfile: true };
  localStorage.setItem('token', authToken);
  localStorage.setItem('auth_token', authToken);
  localStorage.setItem('ml_auth_token', authToken);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token, identity });

const page = await context.newPage();
await page.goto(`${base}/learning`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '进入学习', exact: true }).click();
await page.waitForTimeout(1800);

const state = await page.evaluate(() => {
  const h1 = document.querySelector('[data-testid="mylearning-detail"] h1');
  const rect = h1?.getBoundingClientRect();
  const primaryButtons = Array.from(document.querySelectorAll('[data-testid="mylearning-detail"] .ant-btn-primary'))
    .filter((node) => node.getBoundingClientRect().height > 0)
    .map((node) => node.textContent?.trim());
  return {
    h1Width: Math.round(rect?.width ?? 0),
    h1Height: Math.round(rect?.height ?? 0),
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    text: document.querySelector('[data-testid="mylearning-detail"]')?.textContent ?? '',
    primaryButtons,
  };
});

const checks = {
  noHorizontalOverflow: state.horizontalOverflow <= 2,
  titleHasUsableWidth: state.h1Width >= 180,
  titleDoesNotCollapseVertically: state.h1Height <= 180,
  hasCurrentTask: state.text.includes('当前任务'),
  hasTutorCta: state.text.includes('AI 导师带我学'),
};
const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures, state: { ...state, text: undefined } }, null, 2));
await browser.close();
if (failures.length) process.exit(1);

