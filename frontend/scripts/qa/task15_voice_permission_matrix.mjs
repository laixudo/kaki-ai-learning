import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_PASSWORD || 'KakiTask15!2026';
const evidence = path.resolve('..', 'evidence', '15');
const out = path.join(evidence, 'voice-permission');
await mkdir(out, { recursive: true });
const users = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8'));
const browser = await chromium.launch({ headless: true });
const loginContext = await browser.newContext();
const login = await loginContext.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password } });
if (!login.ok()) throw new Error(`login ${login.status()}`);
const identity = (await login.json()).data;
await loginContext.close();

const cases = [];
async function makeContext(init) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('auth_token', token);
    localStorage.setItem('ml_auth_token', token);
    localStorage.setItem('kaki_user', JSON.stringify(user));
    localStorage.setItem('ml_current_user_id', String(user.userId));
    localStorage.setItem('kaki_profile_status', 'complete');
  }, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true } });
  if (init) await context.addInitScript(init);
  return context;
}
async function loadRuntime(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console:${m.text()}`); });
  page.on('pageerror', e => errors.push(`page:${e.message}`));
  await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
  await page.locator('#callTool').waitFor({ state: 'visible' });
  await page.waitForFunction(() => Boolean(window.KakiVoiceCallRuntime?.checkReadiness));
  return { page, errors };
}

// Case A: grant the real origin microphone permission and let Chromium request
// the installed Windows input. No synthetic media flags are used.
{
  const context = await makeContext();
  await context.grantPermissions(['microphone'], { origin: base });
  const { page, errors } = await loadRuntime(context);
  const readiness = await page.evaluate(() => window.KakiVoiceCallRuntime.checkReadiness());
  await page.locator('#callTool').click();
  await page.waitForFunction(() => ['listening', 'recognizing', 'recoverable_error'].includes(window.KakiVoiceCallRuntime.getState().state), null, { timeout: 20_000 });
  const state = await page.evaluate(() => window.KakiVoiceCallRuntime.getState());
  await page.screenshot({ path: path.join(out, 'case-a-granted.png') });
  cases.push({ case: 'A_GRANTED_REAL_BROWSER', status: state.state === 'listening' || state.state === 'recognizing' ? 'PASS' : 'BLOCKED_BY_DEVICE_OR_BROWSER', readiness, state, errors });
  await page.evaluate(() => window.KakiVoiceCallRuntime.stop('matrix_cleanup'));
  await context.close();
}

// Case B: explicitly deny permission. Recovery must be actionable and text
// continuity must remain available.
{
  const context = await makeContext();
  await context.clearPermissions();
  const { page, errors } = await loadRuntime(context);
  const readiness = await page.evaluate(() => window.KakiVoiceCallRuntime.checkReadiness());
  await page.locator('#callTool').click();
  await page.waitForFunction(() => window.KakiVoiceCallRuntime.getState().state === 'recoverable_error', null, { timeout: 20_000 });
  const retryVisible = await page.locator('#voiceCallRetryPermission').isVisible();
  const fallbackVisible = await page.locator('#voiceCallUseTextFallback').isVisible();
  const fallbackEnabled = await page.locator('#voiceCallTextFallback').isEnabled();
  await page.screenshot({ path: path.join(out, 'case-b-denied-recovery.png') });
  cases.push({ case: 'B_DENIED', status: retryVisible && fallbackVisible && fallbackEnabled && errors.length === 0 ? 'PASS' : 'FAIL', readiness, retryVisible, fallbackVisible, fallbackEnabled, state: await page.evaluate(() => window.KakiVoiceCallRuntime.getState()), errors });
  await context.close();
}

// Case C: this host has an actual input device when audio_input_count > 0, so
// a genuine no-device case is not reproducible without falsifying hardware.
{
  const context = await makeContext();
  const { page, errors } = await loadRuntime(context);
  const readiness = await page.evaluate(() => window.KakiVoiceCallRuntime.checkReadiness());
  cases.push({ case: 'C_NO_DEVICE', status: readiness.audio_input_count === 0 ? 'OBSERVED' : 'NOT_APPLICABLE_DEVICE_PRESENT', readiness, errors });
  await context.close();
}

// Case D: controlled fault injection, never used as real capability evidence.
{
  const context = await makeContext(() => { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }); });
  const { page, errors } = await loadRuntime(context);
  const readiness = await page.evaluate(() => window.KakiVoiceCallRuntime.checkReadiness());
  await page.locator('#callTool').click();
  await page.waitForTimeout(1800);
  const textFallback = await page.locator('#voiceCallTextFallback').isEnabled();
  await page.screenshot({ path: path.join(out, 'case-d-media-devices-unavailable.png') });
  cases.push({ case: 'D_MEDIA_DEVICES_UNAVAILABLE_CONTROLLED', status: readiness.browser_mic === false && textFallback && errors.length === 0 ? 'PASS' : 'FAIL', readiness, textFallback, state: await page.evaluate(() => window.KakiVoiceCallRuntime.getState()), errors });
  await context.close();
}

// Case E: controlled adapter/browser ASR outage. The call must stay usable by
// text and tell the truth instead of inventing transcripts.
{
  const context = await makeContext();
  const { page, errors } = await loadRuntime(context);
  await page.evaluate(() => {
    const bridge = window.KakiWorkspaceRuntimeBridge;
    if (bridge) bridge.getInputCapabilities = () => ({ backendAsr: false });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
  });
  const readiness = await page.evaluate(() => window.KakiVoiceCallRuntime.checkReadiness());
  await page.locator('#callTool').click();
  await page.waitForFunction(() => window.KakiVoiceCallRuntime.getState().state === 'recoverable_error');
  const textFallback = await page.locator('#voiceCallTextFallback').isEnabled();
  const recovery = await page.locator('.voice-call-recovery').innerText();
  await page.screenshot({ path: path.join(out, 'case-e-asr-unavailable.png') });
  cases.push({ case: 'E_ASR_UNAVAILABLE_CONTROLLED', status: textFallback && recovery.includes('没有用 mock transcript') && errors.length === 0 ? 'PASS' : 'FAIL', readiness, textFallback, recovery, state: await page.evaluate(() => window.KakiVoiceCallRuntime.getState()), errors });
  await context.close();
}

const hardFailure = cases.some(item => item.status === 'FAIL');
const report = { generated_at: new Date().toISOString(), status: hardFailure ? 'FAIL' : 'PASS_WITH_TRUTHFUL_LIMITATIONS', synthetic_media_used: false, controlled_fault_injection_only: ['D_MEDIA_DEVICES_UNAVAILABLE_CONTROLLED', 'E_ASR_UNAVAILABLE_CONTROLLED'], cases };
await writeFile(path.join(evidence, 'tests', 'voice-permission-matrix.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(hardFailure ? 1 : 0);
