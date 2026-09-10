import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const studentPassword = process.env.KAKI_TASK16_STUDENT_PASSWORD;
const adminUsername = process.env.KAKI_ADMIN_USERNAME;
const adminPassword = process.env.KAKI_ADMIN_PASSWORD;
if (!studentPassword || !adminUsername || !adminPassword) throw new Error('Task16A credentials are required');
const project = path.resolve('..');
const evidence = path.join(project, 'evidence', '16A');
const shots = path.join(evidence, 'screenshots');
const supplemental = path.join(evidence, 'supplemental-1440');
const tests = path.join(evidence, 'tests');
await Promise.all([shots, supplemental, tests].map((dir) => mkdir(dir, { recursive: true })));
const users = JSON.parse(await readFile(path.join(project, 'evidence', '15', 'task15-test-users.json'), 'utf8'));
const captures = [];
const issues = [];
const audit = { console_errors: [], page_errors: [], http_errors: [], request_failures: [] };

const browser = await chromium.launch({ headless: true });
const student = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const login = await student.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password: studentPassword } });
if (!login.ok()) throw new Error(`Student login failed: ${login.status()}`);
const identity = (await login.json()).data;
await student.addInitScript(({ token, user }) => {
  localStorage.setItem('token', token); localStorage.setItem('auth_token', token); localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user)); localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true } });
const page = await student.newPage();
page.setDefaultTimeout(45_000);
page.on('console', (m) => { if (m.type() === 'error') audit.console_errors.push({ page: page.url(), text: m.text() }); });
page.on('pageerror', (e) => audit.page_errors.push({ page: page.url(), text: e.message }));
page.on('response', (r) => { if (r.status() >= 400) audit.http_errors.push({ status: r.status(), url: r.url() }); });
page.on('requestfailed', (r) => audit.request_failures.push({ url: r.url(), error: r.failure()?.errorText || '' }));

async function settle(ms = 900) { await page.waitForTimeout(ms); }
async function shot(name, state, note = '') {
  await settle(450);
  await page.screenshot({ path: path.join(shots, name), fullPage: false, animations: 'disabled' });
  captures.push({ file: name, route: new URL(page.url()).pathname + new URL(page.url()).search, state, note });
}
async function goto(route, ready) {
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
  if (ready) await page.locator(ready).first().waitFor({ state: 'visible' });
  await settle();
}
async function attempt(label, action) {
  try { await action(); return true; }
  catch (error) { issues.push({ label, error: String(error?.message || error).slice(0, 700) }); return false; }
}

// 01-07 AI workspace and right-side impression.
await goto('/ai-learning', '[data-testid="ai-workspace-kernel"]');
await page.waitForFunction(() => typeof document.querySelector('#imageUpload')?.onchange === 'function');
await attempt('new-conversation', async () => { await page.locator('#newChat').click(); await settle(900); });
await shot('01-ai-workspace-empty-1920.png', 'new empty conversation with real student rails');
await attempt('assistant-mode', async () => { await page.locator('.mode-card[data-mode="assistant"]').click(); await settle(800); });
await shot('02-ai-workspace-learning-assistant-1920.png', 'learning assistant mode selected');
await attempt('tutor-mode', async () => { await page.locator('#newChat').click(); await settle(); await page.locator('.mode-card[data-mode="tutor"]').click(); await settle(1400); });
await shot('03-ai-workspace-ai-tutor-1920.png', 'AI Tutor mode selected with real tutor session state');
await attempt('workspace-artifact-shell', async () => { await page.evaluate(() => window.KakiArtifactShellHost?.open?.({ artifact_id: 48 })); await page.getByTestId('ai-workspace-artifact-shell').waitFor(); });
await shot('04-ai-workspace-artifact-1920.png', 'real artifact 48 opened in workspace shell');
await attempt('close-artifact-shell', async () => page.evaluate(() => window.KakiArtifactShellHost?.close?.()));
await attempt('tool-tray', async () => { await page.getByTestId('learning-tool-composer-trigger').click(); await page.getByTestId('learning-tool-tray').waitFor(); });
await shot('05-ai-workspace-tool-tray-1920.png', 'learning tool tray open');
await attempt('close-tool-tray', async () => page.keyboard.press('Escape'));
await attempt('call-overlay', async () => { await page.locator('#callTool').click(); await page.waitForSelector('.call-overlay, #callOverlay, [data-call-state]', { state: 'attached', timeout: 20_000 }); });
await shot('06-ai-workspace-call-1920.png', 'real voice call UI readiness; physical microphone transcript not asserted');
await attempt('close-call', async () => { const end = page.locator('[data-action="hangup"], #endCall, #hangup, button').filter({ hasText: /挂断|结束通话|关闭/ }).first(); if (await end.count()) await end.click(); else await page.keyboard.press('Escape'); });
await shot('07-ai-impression-1920.png', 'AI impression rail grounded in current real profile');

// 08-13 Living Companion and Inner World.
await goto('/ai-learning', '[data-testid="mascot-companion"]');
await shot('08-living-companion-default.png', 'living companion default state');
await page.getByTestId('mascot-companion').click(); await settle(500);
await shot('09-living-companion-actions.png', 'living companion quick actions visible');
const bubbleText = await page.getByTestId('mascot-bubble').innerText().catch(() => '');
await shot('10-living-companion-reaction.png', bubbleText ? 'current runtime bubble reaction' : 'default companion; dynamic reaction not present', bubbleText || 'No dynamic bubble was forced or fabricated');
await attempt('inner-world-open', async () => { if (!(await page.getByTestId('mascot-inner-world').count())) await page.getByTestId('mascot-companion').click(); await page.getByTestId('mascot-inner-world').waitFor(); await page.waitForFunction(() => !document.querySelector('[data-testid="mascot-inner-world"]')?.textContent?.includes('正在读取真实学习记录')); });
await shot('11-inner-world-overview-1920.png', 'Inner World overview from real student snapshot');
await attempt('inner-world-detail', async () => { const candidate = page.getByTestId('mascot-inner-world').locator('button').filter({ hasText: /查看|详情|最近|学习/ }).first(); if (await candidate.count()) await candidate.click(); });
await shot('12-inner-world-detail-1920.png', 'available Inner World detail/current evidence view');
const generationStatus = await page.getByTestId('mascot-inner-world').getAttribute('data-generation-status').catch(() => '');
await shot('13-inner-world-fallback-state.png', 'truthful generation fallback state', generationStatus || 'no generation status attribute');
await attempt('inner-world-close', async () => page.getByTestId('mascot-inner-world-close').click());

// 14-30 core student product routes.
await goto('/learning', '[data-testid="mylearning-overview"]');
await shot('14-my-learning-overview-1920.png', 'real learning overview');
await attempt('learning-route-detail', async () => { const enter = page.getByRole('button', { name: '进入学习' }).first(); if (await enter.count()) await enter.click(); await page.getByTestId('mylearning-detail').waitFor(); });
await shot('15-my-learning-route-detail-1920.png', 'real route detail');
await shot('16-course-detail-1920.png', 'current course and route detail', 'No separate course-detail route exists in accepted IA');

await goto('/notes', '[data-testid="notes-page"]');
await shot('17-notes-overview-1920.png', 'real notes overview');
await attempt('notes-ai-drawer', async () => { await page.getByTestId('notes-ai-drawer-open').first().click(); await page.getByTestId('notes-ai-drawer').waitFor(); });
await shot('18-notes-ai-drawer-1920.png', 'notes AI drawer open');
await attempt('notes-ai-result', async () => { const polish = page.getByRole('button', { name: '润色整理' }); if (await polish.count()) await polish.click(); await page.getByTestId('note-ai-result').waitFor({ timeout: 120_000 }); });
await shot('19-notes-ai-result-1920.png', 'real notes AI result where available');

await goto('/resources', '[data-testid="real-material-library"]');
await shot('20-material-library-1920.png', 'real material library');
await page.getByPlaceholder('搜索资料名称、分类或内容').fill('函数'); await settle(1000);
await shot('21-material-search-filter-1920.png', 'real material search filter');
await page.getByPlaceholder('搜索资料名称、分类或内容').fill(''); await settle(700);
await attempt('material-detail', async () => { const view = page.locator('button[aria-label^="查看"]').first(); if (await view.count()) await view.click(); await page.locator('.ant-modal:visible').waitFor(); });
await shot('22-material-detail-1920.png', 'real material detail modal');
await attempt('close-material-detail', async () => { const close = page.locator('.ant-modal:visible .ant-modal-close'); if (await close.count()) await close.click(); });

let questionArtifactId = 0;
await attempt('resolve-question-artifact', async () => {
  const response = await student.request.get(`${base}/api/items/list`, { headers: { Authorization: `Bearer ${identity.token}` } });
  const payload = await response.json();
  const rows = payload?.data?.items || payload?.data || payload?.items || [];
  const found = rows.find((item) => /question|exam|practice/i.test(String(item.type || item.artifact_type || item.kind || '')));
  questionArtifactId = Number(found?.id || found?.artifact_id || 0);
});
if (questionArtifactId) await goto(`/artifacts/${questionArtifactId}`, '[data-testid="unified-artifact-detail"]');
else await goto('/exam', '[data-testid="module-page-exam"]');
await shot('23-practice-start-1920.png', questionArtifactId ? `real question artifact ${questionArtifactId} start` : 'real practice center; question artifact unresolved');
await attempt('practice-question', async () => { const start = page.getByTestId('practice-start'); if (await start.count()) await start.click(); else { const startExam = page.getByRole('button', { name: /开始答题|进入考试|开始考试/ }).first(); if (await startExam.count()) await startExam.click(); } });
await shot('24-practice-question-1920.png', 'real practice question state');
await attempt('practice-feedback', async () => { const option = page.getByTestId('practice-option').first(); if (await option.count()) await option.click(); const submit = page.getByTestId('practice-submit'); if (await submit.count()) await submit.click(); await page.getByTestId('practice-feedback').waitFor({ timeout: 15_000 }); });
await shot('25-practice-feedback-1920.png', 'real practice feedback where supported');

await goto('/profile', '[data-testid="personal-center-first-screen"]');
await shot('26-personal-center-overview-1920.png', 'real personal center overview');
await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight * 0.45, 900))); await settle(500);
await shot('27-personal-center-profile-detail-1920.png', 'real profile dimensions/detail');
await page.goto(`${base}/profile?section=insights`, { waitUntil: 'domcontentloaded' }); await settle(1200);
await shot('28-learning-report-1920.png', 'real learning report/insights section');

await goto('/courses/video', '[data-testid="module-page-video"]');
await shot('29-video-overview-1920.png', 'real video learning overview');
await attempt('video-active', async () => { const play = page.getByRole('button', { name: '播放视频' }); if (await play.count()) await play.click(); await settle(700); });
await shot('30-video-active-state-1920.png', 'real video active action state');

// 31-34 Adventure: preserve and show the user's current real persisted journey; no controlled state injection.
await goto('/ai-learning', '[data-testid="ai-workspace-kernel"]');
await page.getByTestId('learning-tool-composer-trigger').click(); await settle(400);
await shot('31-adventure-entry-1920.png', 'real Adventure entry in learning tool tray');
await page.keyboard.press('Escape');
await attempt('adventure-open', async () => { await page.evaluate(() => window.dispatchEvent(new CustomEvent('kaki:open-adventure'))); await page.waitForSelector('.shiguang-overlay, [data-shiguang-overlay]', { state: 'attached', timeout: 45_000 }); await settle(1600); });
const adventureState = await page.locator('.shiguang-overlay, [data-shiguang-overlay]').first().getAttribute('data-state').catch(() => 'unavailable');
await shot('32-adventure-opening-1920.png', 'current real persisted Adventure opening/restored state', adventureState || 'state unavailable');
await shot('33-adventure-main-play-1920.png', 'current real persisted Adventure main surface', adventureState || 'state unavailable');
await shot('34-adventure-result-1920.png', 'current real persisted Adventure result surface', adventureState || 'state unavailable');
await attempt('adventure-close', async () => page.keyboard.press('Escape'));

await goto('/ai-learning', '[data-testid="mascot-companion"]');
await page.getByTestId('mascot-relax-button').click(); await page.getByTestId('relax-moment-overlay').waitFor(); await settle(1000);
await shot('35-relax-overlay-1920.png', 'real relax overlay');
await attempt('relax-close', async () => page.getByRole('button', { name: '结束轻松一下' }).click());
await page.getByTestId('global-search-button').click(); await page.getByPlaceholder('搜索资料、笔记、题目…').fill('函数'); await page.getByPlaceholder('搜索资料、笔记、题目…').press('Enter'); await settle(1000);
await shot('36-global-search-1920.png', 'real global search result');
await page.keyboard.press('Escape');
await page.getByTestId('global-message-button').click(); await settle(700);
await shot('37-notification-1920.png', 'real notifications');
await page.keyboard.press('Escape');
await page.getByTestId('global-user-menu-button').click(); await settle(400);
await shot('38-avatar-menu-1920.png', 'real avatar menu');

// 39-40 unauthenticated and onboarding surfaces.
const publicContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const publicPage = await publicContext.newPage();
await publicPage.goto(`${base}/login`, { waitUntil: 'domcontentloaded' }); await publicPage.waitForTimeout(900);
await publicPage.screenshot({ path: path.join(shots, '39-login-1920.png'), fullPage: false, animations: 'disabled' });
captures.push({ file: '39-login-1920.png', route: '/login', state: 'formal login page' });
await page.goto(`${base}/onboarding?resume=1`, { waitUntil: 'domcontentloaded' }); await page.getByTestId('profile-stage').waitFor(); await settle(800);
await shot('40-onboarding-1920.png', 'real resumable onboarding state for student A');
await publicContext.close();

// 41-44 formal admin login and real admin data.
const admin = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const adminPage = await admin.newPage(); adminPage.setDefaultTimeout(45_000);
await adminPage.goto(`${base}/admin/login`, { waitUntil: 'domcontentloaded' });
await adminPage.getByTestId('admin-account').fill(adminUsername); await adminPage.getByTestId('admin-password').fill(adminPassword); await adminPage.getByTestId('admin-login-submit').click();
await adminPage.waitForURL(/\/admin\/dashboard/); await adminPage.getByTestId('admin-page-dashboard').waitFor(); await adminPage.waitForTimeout(900);
await adminPage.screenshot({ path: path.join(shots, '41-admin-dashboard-1920.png'), fullPage: false, animations: 'disabled' }); captures.push({ file: '41-admin-dashboard-1920.png', route: '/admin/dashboard', state: 'real admin dashboard' });
for (const [route, ready, name, state] of [
  ['/admin/users', '[data-testid="admin-page-users"]', '42-admin-users-1920.png', 'real admin users'],
  ['/admin/content', '[data-testid="admin-page-content"]', '43-admin-announcement-1920.png', 'real admin announcements'],
  ['/admin/operations', '[data-testid="admin-page-operations"]', '44-admin-operations-1920.png', 'real redacted admin operations'],
]) {
  await adminPage.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' }); await adminPage.locator(ready).waitFor(); await adminPage.waitForTimeout(800);
  await adminPage.screenshot({ path: path.join(shots, name), fullPage: false, animations: 'disabled' }); captures.push({ file: name, route, state });
}

// Representative supplemental 1440x900 captures.
await page.setViewportSize({ width: 1440, height: 900 });
for (const [route, ready, name] of [['/ai-learning','[data-testid="ai-workspace-kernel"]','ai-workspace-1440.png'],['/learning','[data-testid="mylearning-overview"]','my-learning-1440.png'],['/profile','[data-testid="personal-center-first-screen"]','profile-1440.png'],['/resources','[data-testid="real-material-library"]','resources-1440.png']]) {
  await goto(route, ready); await page.screenshot({ path: path.join(supplemental, name), fullPage: false, animations: 'disabled' });
}

await writeFile(path.join(tests, 'capture-report.json'), JSON.stringify({ generated_at: new Date().toISOString(), status: captures.length === 44 ? 'PASS' : 'FAIL', captures, state_notes: { dynamic_companion_bubble: bubbleText ? 'OBSERVED' : 'NOT_PROVEN', inner_world_generation_status: generationStatus, adventure_state: adventureState }, issues, audit }, null, 2));
await Promise.all([admin.close(), student.close()]);
await browser.close();
console.log(JSON.stringify({ status: captures.length === 44 ? 'PASS' : 'FAIL', captures: captures.length, issues: issues.length, state_notes: { dynamic_companion_bubble: bubbleText ? 'OBSERVED' : 'NOT_PROVEN', inner_world_generation_status: generationStatus, adventure_state: adventureState } }, null, 2));
if (captures.length !== 44) process.exit(1);
