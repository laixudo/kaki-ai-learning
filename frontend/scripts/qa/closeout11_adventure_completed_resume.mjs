import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
const sourceReport = process.env.KAKI_SOURCE_REPORT;
const output = process.env.KAKI_EVIDENCE || path.resolve('../evidence/11/adventure-completed-resume');
if (!sourceReport) throw new Error('KAKI_SOURCE_REPORT is required');
await mkdir(output, { recursive: true });
const source = JSON.parse(await readFile(sourceReport, 'utf8'));
const username = source.user.username;
const password = 'Dynamic10!2026';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
if (!login.ok()) throw new Error(`login failed with HTTP ${login.status()}`);
const auth = (await login.json()).data;
const headers = { Authorization: `Bearer ${auth.token}` };
await context.addInitScript(({ token, userId, currentUsername }) => {
  const user = { userId, username: currentUsername, hasProfile: true };
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: auth.token, userId: auth.user_id, currentUsername: username });

const page = await context.newPage();
const errors = [];
const checks = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
const check = (name, pass, details = null) => checks.push({ name, pass: Boolean(pass), details });

async function drainDialogue() {
  for (let turn = 0; turn < 64; turn += 1) {
    const dialogue = page.locator('.shiguang-dialogue');
    if (!await dialogue.count()) return;
    const next = dialogue.locator('[data-action="dialogue-next"]');
    await next.click();
    await page.waitForTimeout(180);
  }
}

const currentResponse = await context.request.get(`${base}/api/adventure/current`, { headers });
const current = (await currentResponse.json()).data;
check('completed run leaves no false active run', currentResponse.ok() && current === null, { current });

const rewardsResponse = await context.request.get(`${base}/api/adventure/rewards`, { headers });
const rewardData = (await rewardsResponse.json()).data;
const rewards = Array.isArray(rewardData) ? rewardData : (rewardData?.items || rewardData?.rewards || []);
check('completed run persists a real reward', rewardsResponse.ok() && rewards.length > 0, { rewards: rewards.length });
const reward = rewards[0];
const artifactId = Number(reward?.artifact_id || 0);
check('completed reward is bound to a real artifact', artifactId > 0, { artifact_id: artifactId });

if (artifactId > 0) {
  const artifactResponse = await context.request.get(`${base}/api/chat/tasks/artifacts/${artifactId}`, { headers });
  check('completed summary artifact remains readable', artifactResponse.ok(), { status: artifactResponse.status(), artifact_id: artifactId });
  if (!reward?.equipped) {
    const equipResponse = await context.request.post(`${base}/api/adventure/rewards/equip`, {
      headers,
      data: { artifact_id: artifactId, replace_confirmed: false },
    });
    check('reward equip persists through the real endpoint', equipResponse.ok(), { status: equipResponse.status() });
  } else {
    check('reward was already equipped', true, { artifact_id: artifactId });
  }
}

await page.goto(`${base}/artifacts`, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="module-page-artifacts"]').waitFor({ state: 'visible' });
await page.waitForTimeout(800);
check('completed artifact is visible in the real product library', artifactId > 0 && (await page.locator(`a[href="/artifacts/${artifactId}"], [data-artifact-id="${artifactId}"]`).count() > 0 || (await page.locator('body').innerText()).includes('拾光漫游')));
await page.screenshot({ path: path.join(output, 'completed-artifact-library.png'), fullPage: true });

await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="module-page-artifacts"]').waitFor({ state: 'visible' });
await page.waitForTimeout(600);
check('refresh still shows the completed artifact library', (await page.locator('body').innerText()).includes('拾光漫游'));
await page.screenshot({ path: path.join(output, 'completed-artifact-after-refresh.png'), fullPage: true });

check('resume has no browser errors', errors.length === 0, errors);
const failures = checks.filter((item) => !item.pass);
const report = { status: failures.length ? 'FAIL' : 'PASS', source_report: sourceReport, user: { user_id: auth.user_id, username }, checks, errors };
await writeFile(path.join(output, 'completed-resume-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (failures.length) process.exit(1);
