import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_PASSWORD || 'KakiTask15!2026';
const evidence = path.resolve('..', 'evidence', '15');
const out = path.join(evidence, 'voice-permission');
await mkdir(out, { recursive: true });
const users = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: false });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, recordVideo: { dir: out, size: { width: 1366, height: 900 } } });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username: users.a.username, password } });
if (!login.ok()) throw new Error(`login ${login.status()}`);
const identity = (await login.json()).data;
await context.addInitScript(({ token, user }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: identity.token, user: { userId: identity.user_id, username: identity.username, hasProfile: true } });
await context.grantPermissions(['microphone'], { origin: base });
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(`console:${m.text()}`); });
page.on('pageerror', e => errors.push(`page:${e.message}`));
await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
await page.locator('#callTool').waitFor({ state: 'visible' });
await page.waitForFunction(() => Boolean(window.KakiVoiceCallRuntime?.checkReadiness));
const readiness = await page.evaluate(() => window.KakiVoiceCallRuntime.checkReadiness());
await page.locator('#callTool').click();
await page.waitForFunction(() => ['listening', 'recognizing', 'recoverable_error'].includes(window.KakiVoiceCallRuntime.getState().state), null, { timeout: 25_000 });
const state = await page.evaluate(() => window.KakiVoiceCallRuntime.getState());
await page.screenshot({ path: path.join(out, 'case-a-edge-real-device.png') });
let loopback = { status: 'NOT_RUN', source: 'real Edge TTS through Windows audio output into physical microphone; not a synthetic media stream' };
if ((state.state === 'listening' || state.state === 'recognizing') && errors.length === 0) {
  const phrase = '请用一句话解释函数单调性';
  const speechResponse = await context.request.post(`${base}/api/video/speech`, { headers: { Authorization: `Bearer ${identity.token}` }, data: { text: phrase, voice: 'zh-CN-XiaoxiaoNeural' } });
  if (speechResponse.ok()) {
    const audioPath = path.join(out, 'real-hardware-loopback-source.mp3');
    await writeFile(audioPath, await speechResponse.body());
    const escaped = audioPath.replaceAll("'", "''");
    const command = `Add-Type -AssemblyName PresentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([uri]'${escaped}'); Start-Sleep -Milliseconds 700; $player.Volume = 1; $player.Play(); Start-Sleep -Seconds 7; $player.Close()`;
    const player = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    try {
      await page.waitForFunction(() => document.querySelector('.voice-call-transcript')?.textContent?.includes('你：'), null, { timeout: 120_000 });
      const transcript = await page.locator('.voice-call-transcript').innerText();
      await page.screenshot({ path: path.join(out, 'case-a-edge-real-asr-loopback.png') });
      loopback = { status: 'PASS', source: loopback.source, requested_phrase: phrase, transcript_excerpt: transcript.slice(0, 500) };
    } catch (error) {
      loopback = { status: 'BLOCKED_NO_TRANSCRIPT', source: loopback.source, requested_phrase: phrase, error: String(error) };
    } finally {
      if (!player.killed) player.kill();
    }
  } else {
    loopback = { status: 'BLOCKED_TTS_SOURCE', source: loopback.source, http_status: speechResponse.status() };
  }
}
const report = { generated_at: new Date().toISOString(), browser: 'Microsoft Edge automated separate window', synthetic_media_used: false, readiness, state, loopback, errors, status: (state.state === 'listening' || state.state === 'recognizing') && errors.length === 0 ? 'PASS' : 'BLOCKED_BY_DEVICE_OR_BROWSER' };
await page.evaluate(() => window.KakiVoiceCallRuntime.stop('real_device_test_cleanup'));
await page.waitForTimeout(500);
await context.close();
await browser.close();
await writeFile(path.join(evidence, 'tests', 'voice-edge-real-device.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 2);
