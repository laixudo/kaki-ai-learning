import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const adminUsername = process.env.KAKI_ADMIN_USERNAME;
const adminPassword = process.env.KAKI_ADMIN_PASSWORD;
if (!adminUsername || !adminPassword) throw new Error('Admin credentials are required');
const root = path.resolve('..');
const out = path.join(root, 'evidence', '15');
const shots = path.join(out, 'screenshots');
const rawVideo = path.join(out, 'video', 'raw');
const auditDir = path.join(out, 'console-network');
const testsDir = path.join(out, 'tests');
await Promise.all([shots, rawVideo, auditDir, testsDir].map(p => mkdir(p, { recursive: true })));
const stamp = Date.now();
const password = 'KakiTask15!2026';
const users = {
  a: { username: `task15_student_a_${stamp}`, email: `task15.a.${stamp}@example.test` },
  b: { username: `task15_student_b_${stamp}`, email: `task15.b.${stamp}@example.test` },
};
const checks = [], audits = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 1000) });
const shot = (page, name, fullPage = true) => page.screenshot({ path: path.join(shots, name), fullPage });
function audit(page, label) {
  const item = { label, console_errors: [], page_errors: [], http_errors: [], request_failures: [] };
  page.on('console', m => { if (m.type() === 'error') item.console_errors.push(m.text()); });
  page.on('pageerror', e => item.page_errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) item.http_errors.push({ status: r.status(), method: r.request().method(), url: r.url() }); });
  page.on('requestfailed', r => item.request_failures.push({ method: r.method(), url: r.url(), error: r.failure()?.errorText }));
  audits.push(item); return item;
}
async function waitForAssistantText(page, minLength = 12) {
  await page.waitForFunction(length => {
    const bubbles = document.querySelectorAll('.msg.assistant .message-bubble');
    const last = bubbles[bubbles.length - 1];
    return Boolean(last && (last.textContent || '').trim().length >= length);
  }, minLength, { timeout: 180_000 });
  return page.locator('.msg.assistant .message-bubble').last().innerText();
}
async function register(context, user, fullProfile) {
  const page = await context.newPage(); audit(page, user.username); page.setDefaultTimeout(60_000);
  await page.goto(`${base}/register`, { waitUntil: 'networkidle' });
  if (fullProfile) await shot(page, '01-student-register.png');
  await page.getByTestId('auth-nickname').fill(user.email);
  await page.getByTestId('auth-phone').fill(user.username);
  await page.getByTestId('auth-password').fill(password);
  const pending = page.waitForResponse(r => r.url().includes('/api/auth/register') && r.request().method() === 'POST');
  await page.getByTestId('auth-submit').click();
  const response = await pending;
  check(`${user.username}-ui-register`, response.status() === 200, response.status());
  await page.waitForURL(/\/onboarding/);
  if (fullProfile) {
    await shot(page, '02-student-onboarding.png');
    const answers = [
      '我想系统学会高中数学中的函数与导数，能够独立解决综合题。',
      '我目前是高二学生，正在准备期末考试。',
      '我了解基本函数和求导公式，但单调性综合题还不稳定。',
      '我喜欢先看直观例子，再总结规律，最后做一道小题检验。',
      '每天晚上可以专注学习四十分钟，希望一次完成一个清晰目标。',
      '看到自己能把一道难题讲清楚，会让我愿意持续学习。',
    ];
    let n = 0;
    const confirm = page.getByRole('button', { name: '确认并开始学习', exact: true });
    while (n < answers.length && !await confirm.isVisible().catch(() => false)) {
      await page.getByTestId('profile-answer').waitFor({ state: 'visible' });
      await page.getByTestId('profile-answer').fill(answers[Math.min(n, answers.length - 1)]);
      const profileResponse = page.waitForResponse(r => r.url().includes('/api/profile-onboarding/message') && r.request().method() === 'POST', { timeout: 120_000 });
      await page.getByTestId('profile-send').click();
      const profileResult = await profileResponse;
      check(`onboarding-answer-${n + 1}-http`, profileResult.status() === 200, profileResult.status());
      await page.waitForTimeout(300);
      n++;
    }
    await confirm.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => null);
    check('onboarding-confirmation', await confirm.isVisible().catch(() => false), `answers=${n}`);
    if (await confirm.isVisible().catch(() => false)) { await shot(page, '03-onboarding-confirmation.png'); await confirm.click(); }
  } else {
    await page.getByRole('button', { name: '跳过', exact: true }).click();
  }
  await page.waitForURL(url => !url.pathname.includes('/onboarding'));
  await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
  await page.locator('#input').waitFor({ state: 'visible' });
  const identity = await page.evaluate(() => ({ token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('kaki_user') || 'null') }));
  check(`${user.username}-authenticated`, Boolean(identity.token && identity.user?.userId), JSON.stringify(identity.user));
  return { page, identity };
}

const browser = await chromium.launch({ headless: true });
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: path.join(rawVideo, 'student'), size: { width: 1440, height: 900 } } });
const a = await register(ctxA, users.a, true); const page = a.page;
await shot(page, '04-ai-workspace.png');
const assistantMode = page.locator('.mode-card[data-mode="assistant"]');
if (await assistantMode.isVisible().catch(() => false)) await assistantMode.click();
const beforeChat = await page.locator('.message.assistant,.msg.assistant').count();
await page.locator('#input').fill('请根据我的学习目标，用一个生活例子解释函数单调性，并告诉我下一步应该学什么。');
const chatResponse = page.waitForResponse(r => /\/api\/(chat|agent)/.test(r.url()) && r.request().method() === 'POST', { timeout: 120_000 }).catch(() => null);
await page.locator('#send').click();
await page.waitForFunction(n => document.querySelectorAll('.message.assistant,.msg.assistant').length > n, beforeChat, { timeout: 120_000 });
const chat = await chatResponse;
const answer = await waitForAssistantText(page, 20);
check('learning-assistant-real-response', answer.trim().length > 20, answer);
check('learning-assistant-http', Boolean(chat && chat.status() >= 200 && chat.status() < 300), chat?.status() ?? 'none');
await shot(page, '05-learning-assistant.png');

await page.locator('#materialUpload').setInputFiles(path.join(out, 'inputs', 'task15-learning-note.txt'));
await page.locator('#materialList').waitFor({ state: 'visible', timeout: 120_000 });
await page.waitForFunction(() => /已解析/.test(document.querySelector('#materialList')?.textContent || ''), null, { timeout: 120_000 });
const material = await page.locator('#materialList').innerText();
check('workspace-real-file-upload', material.includes('task15-learning-note'), material);
await shot(page, '06-file-upload.png');

const beforeArtifact = await page.locator('.msg.assistant').count();
await page.locator('#input').fill('请基于刚才上传的资料生成一份简短讲义，并保存为学习产物。');
await page.locator('#send').click();
await page.waitForFunction(n => document.querySelectorAll('.msg.assistant').length > n, beforeArtifact, { timeout: 180_000 });
let proposal = await waitForAssistantText(page, 8);
for (let turn = 0; turn < 4; turn++) {
  let reply = '';
  if (/什么主题|告诉我.*主题/.test(proposal)) reply = '主题是函数单调性与导数。';
  else if (/确认|现在开始吗|是否开始/.test(proposal)) reply = '确认生成并保存。';
  if (!reply) break;
  const beforeReply = await page.locator('.msg.assistant').count();
  await page.locator('#input').fill(reply);
  await page.locator('#send').click();
  await page.waitForFunction(n => document.querySelectorAll('.msg.assistant').length > n, beforeReply, { timeout: 180_000 });
  proposal = await waitForAssistantText(page, 8);
}
await page.waitForFunction(async () => {
  const token = localStorage.getItem('token');
  const response = await fetch('/api/items/list', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return false;
  const body = await response.json();
  const items = body?.data ?? [];
  return items.some(item => String(item.type || '').includes('lecture'));
}, null, { timeout: 180_000, polling: 1200 }).catch(() => null);
const artifactNodes = await page.locator('[data-artifact-id],.artifact-card,#artifactDrawer:not([hidden]),[data-testid="ai-workspace-artifact-shell"]').count();
const artifactText = await page.locator('.msg.assistant .message-bubble').last().innerText();
const artifactItems = await page.evaluate(async () => {
  const response = await fetch('/api/items/list', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  const body = await response.json(); return (body?.data ?? []).filter(item => String(item.type || '').includes('lecture')).map(item => ({ id:item.id, type:item.type, title:item.title }));
});
check('artifact-generation-response', artifactItems.length > 0, `nodes=${artifactNodes}; items=${JSON.stringify(artifactItems)}; ${artifactText}`);
await shot(page, '07-artifact.png');

for (const [route, name] of [['/learning','08-my-learning.png'],['/notes','09-notes.png'],['/resources','10-material.png'],['/exam','11-practice.png'],['/profile','12-profile.png'],['/artifacts','13-artifacts.png']]) {
  await page.goto(`${base}${route}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(500);
  check(`route-${route}`, page.url().includes(route) && !/404|白屏/.test(await page.locator('body').innerText()), page.url()); await shot(page, name);
}
await page.goto(`${base}/resources`, { waitUntil: 'networkidle' });
check('material-visible-library', (await page.locator('body').innerText()).includes('task15-learning-note'), 'uploaded title lookup');
await page.getByTestId('global-search-button').click();
await page.getByPlaceholder('搜索资料、笔记、题目…').fill('函数单调性');
await page.getByPlaceholder('搜索资料、笔记、题目…').press('Enter'); await page.waitForTimeout(2000); await shot(page, '14-search.png');
check('global-search-completes', (await page.locator('body').innerText()).includes('函数') || (await page.locator('body').innerText()).includes('暂无匹配结果'));
await page.getByTestId('global-message-button').click(); await page.waitForTimeout(500); await shot(page, '15-notification.png');
check('notification-panel', (await page.locator('body').innerText()).includes('通知'));

await page.getByTestId('global-user-menu-button').click(); await page.getByTestId('global-logout-button').click(); await page.waitForURL(/\/login/); await shot(page, '16-logout.png');
await page.goto(`${base}/ai-learning`); await page.waitForURL(/\/login/);
check('logout-invalidates-session', !await page.evaluate(() => Boolean(localStorage.getItem('token'))), page.url());
await page.getByTestId('auth-phone').fill(users.a.username); await page.getByTestId('auth-password').fill(password); await page.getByTestId('auth-submit').click();
await page.waitForURL(url => !url.pathname.includes('/login')); await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' }); await shot(page, '17-relogin.png');
check('relogin-persistence', (await page.locator('body').innerText()).includes('柿子智学'));

const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const b = await register(ctxB, users.b, false); await shot(b.page, '18-user-b.png');
async function summary(p, userId) {
  return p.evaluate(async ({ userId }) => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` }, result = {};
    for (const endpoint of [`/api/chat/history/${userId}`,'/api/chat/materials/library','/api/items/list','/api/notes',`/api/plans/active/${userId}`]) {
      const r = await fetch(endpoint, { headers }); let body = null; try { body = await r.json(); } catch {}
      const data = body?.data ?? body; const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      const normalized = Array.isArray(data) ? list : data ? [data] : [];
      result[endpoint.replace(String(userId),'{self}')] = { status:r.status, count:normalized.length, ids:normalized.map(x => x.id ?? x.thread_id ?? x.material_id ?? x.plan_id).filter(Boolean).slice(0,20) };
    } return result;
  }, { userId });
}
const isoA = await summary(page, a.identity.user.userId), isoB = await summary(b.page, b.identity.user.userId);
const intersections = Object.keys(isoA).flatMap(k => isoB[k].ids.filter(id => new Set(isoA[k].ids.map(String)).has(String(id))).map(id => `${k}:${id}`));
check('two-user-id-isolation', intersections.length === 0, JSON.stringify({ isoA, isoB, intersections }));

const adminCtx = await browser.newContext({ viewport:{width:1440,height:900}, recordVideo:{dir:path.join(rawVideo,'admin'),size:{width:1440,height:900}} });
const admin = await adminCtx.newPage(); audit(admin,'admin'); admin.setDefaultTimeout(60_000);
await admin.goto(`${base}/admin/login`, { waitUntil:'networkidle' }); await shot(admin,'19-admin-login.png');
await admin.getByTestId('admin-account').fill(adminUsername); await admin.getByTestId('admin-password').fill(adminPassword);
const adminPending = admin.waitForResponse(r => r.url().includes('/api/admin/login') && r.request().method()==='POST');
await admin.getByRole('button',{name:'登录管理端',exact:true}).click(); const ar = await adminPending; await admin.waitForURL(/\/admin\/dashboard/); check('admin-real-login',ar.status()===200,ar.status());
for(const [route,name] of [['/admin/dashboard','20-admin-dashboard.png'],['/admin/users','21-admin-users.png'],['/admin/content','22-admin-content.png'],['/admin/operations','23-admin-operations.png'],['/admin/system','24-admin-system.png']]){
  await admin.goto(`${base}${route}`,{waitUntil:'networkidle'}); await admin.waitForTimeout(500); check(`admin-route-${route}`,admin.url().includes(route)&&!(await admin.locator('body').innerText()).includes('404'),admin.url()); await shot(admin,name);
}
check('admin-no-material-title', !(await admin.locator('body').innerText()).includes('task15-learning-note'));
for(const vp of [{width:1920,height:1080},{width:1440,height:900},{width:1280,height:800}]){
  await page.setViewportSize(vp); await page.goto(`${base}/ai-learning`,{waitUntil:'networkidle'}); const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth); check(`workspace-${vp.width}-overflow`,overflow<=2,overflow); await shot(page,`25-workspace-${vp.width}x${vp.height}.png`,false);
}
const redacted={a:{username:users.a.username,user_id:a.identity.user.userId},b:{username:users.b.username,user_id:b.identity.user.userId}};
await writeFile(path.join(out,'task15-test-users.json'),JSON.stringify(redacted,null,2));
await writeFile(path.join(auditDir,'stage1-browser-audit.json'),JSON.stringify({audits,isoA,isoB,checks},null,2));
await Promise.all([ctxA.close(),ctxB.close(),adminCtx.close()]); await browser.close();
const failures=checks.filter(x=>!x.pass); const report={status:failures.length?'FAIL':'PASS',generated_at:new Date().toISOString(),users:redacted,checks,failures,audits};
await writeFile(path.join(testsDir,'stage1-real-usage-report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); if(failures.length) process.exit(1);
