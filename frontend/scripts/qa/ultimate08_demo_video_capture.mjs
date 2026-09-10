import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
const output = process.env.KAKI_DEMO_OUTPUT || 'C:/Users/wuzbo/Desktop/KAKI-FINAL-DEMO-ASSETS-20260810-FINAL';
const username = process.env.KAKI_DEMO_USER;
const password = process.env.KAKI_DEMO_PASSWORD;
const adminUsername = process.env.KAKI_ADMIN_USER;
const adminPassword = process.env.KAKI_ADMIN_PASSWORD;
if (!username || !password || !adminUsername || !adminPassword) throw new Error('demo user and admin credentials are required');

const rawDir = path.join(output, 'raw-real-browser');
await mkdir(rawDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { status: 'PASS', base, student: null, admin: null, errors: [] };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stablePan(page) {
  await page.mouse.move(330, 260, { steps: 24 });
  await delay(900);
  await page.mouse.move(1180, 620, { steps: 30 });
  await delay(900);
}

async function createStudentContext() {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
  });
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
  if (!login.ok()) throw new Error(`student login returned ${login.status()}`);
  const data = (await login.json()).data;
  await context.addInitScript(({ token, userId, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('auth_token', token);
    localStorage.setItem('ml_auth_token', token);
    localStorage.setItem('kaki_user', JSON.stringify({ userId, username: user, hasProfile: true }));
    localStorage.setItem('ml_current_user_id', String(userId));
    localStorage.setItem('kaki_profile_status', 'complete');
  }, { token: data.token, userId: data.user_id, user: data.username });
  return context;
}

async function captureStudent() {
  const context = await createStudentContext();
  const page = await context.newPage();
  const video = page.video();
  const started = Date.now();
  const markers = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.setDefaultTimeout(30_000);
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const at = () => Number(((Date.now() - started) / 1000).toFixed(3));

  async function segment(name, route, action) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    markers.push({ name, start: at() });
    await stablePan(page);
    if (action) await action(page);
    await page.waitForTimeout(6500);
    markers.at(-1).end = at();
  }

  await segment('01_HOME_ONBOARDING', '/', async (p) => {
    await p.evaluate(() => window.scrollTo({ top: Math.min(360, document.body.scrollHeight), behavior: 'smooth' }));
  });
  await segment('02_AI_TUTOR_PERSONALIZATION', '/ai-learning', async (p) => {
    const input = p.locator('#input');
    if (await input.count()) await input.fill('请根据我刚才的学习情况，继续用我容易理解的方式讲解。');
  });
  await segment('03_LEARNING_PLAN_COURSE_DETAIL', '/learning', async (p) => {
    await p.evaluate(() => window.scrollTo({ top: 430, behavior: 'smooth' }));
  });
  await segment('04_REAL_PRACTICE_FEEDBACK', '/exam', async (p) => {
    await p.evaluate(() => window.scrollTo({ top: 390, behavior: 'smooth' }));
  });
  await segment('05_MATERIAL_ARTIFACT', '/resources', async (p) => {
    await p.evaluate(() => window.scrollTo({ top: 320, behavior: 'smooth' }));
    await p.waitForTimeout(1800);
    await p.goto(`${base}/artifacts`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3200);
  });
  await segment('06_NOTES_AI', '/notes', async (p) => {
    await p.evaluate(() => window.scrollTo({ top: 320, behavior: 'smooth' }));
  });
  await segment('07_VOICE_CALL', '/ai-learning', async (p) => {
    const call = p.locator('#callTool');
    if (await call.count()) await call.click();
    await p.waitForTimeout(2200);
    const fallback = p.locator('#voiceCallTextFallback');
    if (await fallback.count()) await fallback.fill('我想继续聊刚才那个容易混淆的知识点。');
  });
  await segment('08_POST_CALL_MEMORY_QUESTION', '/ai-learning', async (p) => {
    const memory = p.locator('#openMemories');
    if (await memory.count()) await memory.click();
    await p.waitForTimeout(1800);
    const close = p.locator('#closeMemories');
    if (await close.count()) await close.click();
    const input = p.locator('#input');
    if (await input.count()) await input.fill('不用重复背景，直接根据刚才的通话给我出一道题。');
  });
  await segment('09_PROFILE', '/profile', async (p) => {
    await p.evaluate(() => window.scrollTo({ top: 520, behavior: 'smooth' }));
  });
  await segment('10_RELAX', '/ai-learning', async (p) => {
    const trigger = p.getByTestId('relax-moment-trigger');
    if (await trigger.count()) await trigger.click();
    await p.waitForTimeout(1700);
    await p.mouse.click(780, 270);
    await p.waitForTimeout(2600);
  });

  await context.close();
  const raw = path.join(rawDir, 'STUDENT-FEATURES-REAL-BROWSER.webm');
  await video.saveAs(raw);
  return { raw, markers, consoleErrors, pageErrors };
}

async function captureAdmin() {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
  });
  const login = await context.request.post(`${base}/api/admin/login`, { data: { username: adminUsername, password: adminPassword } });
  if (!login.ok()) throw new Error(`admin login returned ${login.status()}`);
  const data = (await login.json()).data;
  await context.addInitScript(({ token, account, admin }) => {
    localStorage.setItem('admin_token', token);
    localStorage.setItem('admin_account', account);
    localStorage.setItem('admin_role', 'admin');
    localStorage.setItem('admin_user', JSON.stringify(admin));
  }, { token: data.token, account: data.admin.username, admin: data.admin });
  const page = await context.newPage();
  const video = page.video();
  const started = Date.now();
  const marker = { name: '15_ADMIN', start: 0, end: 0 };
  await page.goto(`${base}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  marker.start = Number(((Date.now() - started) / 1000).toFixed(3));
  await stablePan(page);
  await page.getByTestId('admin-nav-users').click();
  await page.waitForTimeout(4500);
  await page.getByTestId('admin-nav-operations').click();
  await page.waitForTimeout(5000);
  marker.end = Number(((Date.now() - started) / 1000).toFixed(3));
  await context.close();
  const raw = path.join(rawDir, 'ADMIN-REAL-BROWSER.webm');
  await video.saveAs(raw);
  return { raw, markers: [marker] };
}

try {
  report.student = await captureStudent();
  report.admin = await captureAdmin();
} catch (error) {
  report.status = 'FAIL';
  report.errors.push(error?.stack || String(error));
} finally {
  await browser.close();
}

await writeFile(path.join(output, 'real-browser-video-markers.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'PASS' ? 0 : 1;
