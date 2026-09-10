import { chromium } from '@playwright/test';

const base = process.env.FINAL06_BASE_URL || 'http://127.0.0.1:5174';
const token = process.env.FINAL06_USER_TOKEN;
if (!token) throw new Error('FINAL06_USER_TOKEN is required');

const bootstrap = await chromium.launch({ headless: true });
const requestContext = await bootstrap.newContext();
const me = await requestContext.request.get(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
if (!me.ok()) throw new Error(`Identity failed with HTTP ${me.status()}`);
const identity = (await me.json()).data;
await requestContext.close();

const context = await bootstrap.newContext({ viewport: { width: 1366, height: 900 } });
await context.addInitScript(({ authToken, current }) => {
  const user = { userId: current.user_id, username: current.username, avatarUrl: current.avatar_url ?? null, hasProfile: true };
  localStorage.setItem('token', authToken);
  localStorage.setItem('auth_token', authToken);
  localStorage.setItem('ml_auth_token', authToken);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { authToken: token, current: identity });

const page = await context.newPage();
await page.goto(`${base}/learning`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '进入学习', exact: true }).click();
const task = page.locator('[data-testid="learning-current-task"]');
await task.waitFor({ state: 'visible' });
const expectedNode = (await task.locator('h2').textContent())?.trim();
await task.getByRole('button', { name: 'AI 导师带我学', exact: true }).click();
await page.waitForURL(/\/ai-learning/);
await page.waitForFunction(() => Boolean(window.KakiWorkspaceContextBridge?.getState?.()?.node_ref), null, { timeout: 15_000 });
await page.waitForTimeout(1200);

const state = await page.evaluate(() => ({
  context: window.KakiWorkspaceContextBridge?.getState?.() ?? null,
  mode: document.querySelector('#conversationModeBadge')?.textContent?.trim() ?? '',
  pendingContext: sessionStorage.getItem('kaki_pending_learning_context_v1'),
}));
const checks = {
  reachedTutor: /\/ai-learning/.test(page.url()),
  graphContextBound: Boolean(state.context?.graph_ref?.graph_id),
  exactNodeBound: state.context?.node_ref?.title === expectedNode,
  pendingConsumed: state.pendingContext === null,
  tutorModeSelected: state.mode === 'AI 导师',
};
const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures, expectedNode, state }, null, 2));
await bootstrap.close();
if (failures.length) process.exit(1);
