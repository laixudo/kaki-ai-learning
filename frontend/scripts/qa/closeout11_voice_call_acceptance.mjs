import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const username = process.env.KAKI_USER || 'dynamic10_1786446726208';
const password = process.env.KAKI_PASSWORD || 'Dynamic10!2026';
const evidenceDir = process.env.KAKI_VOICE_EVIDENCE
  || path.resolve('..', 'evidence', '11', 'voice-call-real');
await mkdir(evidenceDir, { recursive: true });

const checks = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
const chatResponses = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password } });
if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`);
const identity = (await login.json()).data;

await context.addInitScript(({ token, user }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(user.userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, {
  token: identity.token,
  user: { userId: identity.user_id, username: identity.username, avatarUrl: identity.avatar_url ?? null, hasProfile: true },
});

const page = await context.newPage();
page.setDefaultTimeout(45_000);
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => pageErrors.push(error.message));
page.on('response', response => {
  if (response.status() >= 500) failedResponses.push({ status: response.status(), url: response.url() });
  if (/\/api\/(chat|agent)/.test(response.url())) chatResponses.push({ status: response.status(), url: response.url() });
});

await page.goto(`${base}/learning`, { waitUntil: 'domcontentloaded' });
const enterLearning = page.getByTestId('learning-route-journey').getByRole('button', { name: '进入学习', exact: true });
await enterLearning.click();
const currentTask = page.locator('[data-testid="learning-current-task"]');
await currentTask.waitFor({ state: 'visible' });
const expectedNode = (await currentTask.locator('h2').textContent())?.trim() || '';
await currentTask.getByRole('button', { name: 'AI 导师带我学', exact: true }).click();
await page.waitForURL(/\/ai-learning/);
await page.waitForTimeout(1500);
await page.waitForFunction(() => Boolean(window.KakiWorkspaceContextBridge?.getState?.()?.node_ref));
const tutorGoalForm = page.locator('.tutor-goal-card form');
await tutorGoalForm.waitFor({ state: 'visible' });
await tutorGoalForm.locator('button[type="submit"]').click();
await page.waitForFunction(() => {
  const context = window.KakiWorkspaceRuntimeBridge?.getCallContext?.();
  return Boolean(context?.tutor_session_id && context?.current_object);
}, null, { timeout: 120_000 });
await page.locator('#callTool').waitFor({ state: 'visible' });
await page.waitForFunction(() => Boolean(window.KakiVoiceCallRuntime?.getCapabilities));
const capabilities = await page.evaluate(() => window.KakiVoiceCallRuntime.getCapabilities());
const boundContext = await page.evaluate(() => window.KakiWorkspaceContextBridge?.getState?.() ?? null);
check('learning-node-bound-before-call', boundContext?.node_ref?.title === expectedNode, JSON.stringify({ expectedNode, boundContext }));
check('voice-runtime-ready', Boolean(capabilities?.voice_persona), JSON.stringify(capabilities));
check('one-voice-persona', Boolean(capabilities?.voice_persona?.voice_id), JSON.stringify(capabilities?.voice_persona));
check('tts-path-reported-honestly', typeof capabilities?.tts_available === 'boolean', String(capabilities?.tts_available));
check('asr-path-reported-honestly', ['backend_faster_whisper', 'browser_web_speech', 'none'].includes(capabilities?.call_asr_engine), capabilities?.call_asr_engine);

await page.locator('#callTool').click();
await page.locator('#kakiVoiceCall').waitFor({ state: 'visible' });
let callState = await page.evaluate(() => window.KakiVoiceCallRuntime.getState());
check('call-opens-in-current-workspace', callState.active === true, JSON.stringify(callState));
await page.screenshot({ path: path.join(evidenceDir, '01-call-open.png'), fullPage: false });

const utterance = '请结合我当前的学习节点，用两句话讲清楚重点，再给我一个自检问题。';
const beforeAssistantCount = await page.locator('.msg.assistant').count();
await page.locator('#voiceCallTextFallback').fill(utterance);
await page.locator('#voiceCallTextFallback').locator('xpath=following-sibling::button').click();
await page.waitForFunction(count => document.querySelectorAll('.msg.assistant').length > count, beforeAssistantCount, { timeout: 120_000 });
await page.waitForFunction(() => {
  const state = window.KakiVoiceCallRuntime?.getState?.();
  return state && !state.formal_send_in_flight;
}, null, { timeout: 120_000 });
const transcriptText = await page.locator('#kakiVoiceCall .voice-call-transcript').innerText();
const assistantText = await page.locator('.msg.assistant').last().innerText();
callState = await page.evaluate(() => window.KakiVoiceCallRuntime.getState());
check('fallback-utterance-enters-formal-conversation', transcriptText.includes(utterance), transcriptText.slice(0, 240));
check('real-assistant-answer-returned', assistantText.trim().length >= 12, assistantText.slice(0, 240));
check('call-remains-active-after-turn', callState.active === true, JSON.stringify(callState));
await page.screenshot({ path: path.join(evidenceDir, '02-real-call-answer.png'), fullPage: false });

await page.locator('#voiceCallInterrupt').click();
await page.waitForTimeout(500);
callState = await page.evaluate(() => window.KakiVoiceCallRuntime.getState());
check('interrupt-keeps-call-recoverable', callState.active === true && callState.ending === false, JSON.stringify(callState));
await page.locator('#voiceCallOutputMute').click();
await page.waitForFunction(() => window.KakiVoiceCallRuntime.getState().output_muted === true);
check('output-mute-state-visible', (await page.evaluate(() => window.KakiVoiceCallRuntime.getState())).output_muted === true);
await page.locator('#voiceCallOutputMute').click();
await page.waitForFunction(() => window.KakiVoiceCallRuntime.getState().output_muted === false);
await page.screenshot({ path: path.join(evidenceDir, '03-interrupt-and-output-control.png'), fullPage: false });

await page.locator('#voiceCallEnd').click();
await page.waitForFunction(() => window.KakiVoiceCallRuntime.getState().active === false, null, { timeout: 60_000 });
await page.locator('#kakiVoiceCall').waitFor({ state: 'hidden' });
check('hangup-restores-workspace', await page.locator('#input').isVisible());

const beforeFollowup = await page.locator('.msg.assistant').count();
const followup = '不重复背景，直接根据刚才通话的重点给我出一道简答题。';
await page.locator('#input').fill(followup);
await page.locator('#send').click();
await page.waitForFunction(count => {
  const assistants = document.querySelectorAll('.msg.assistant').length;
  const artifacts = document.querySelectorAll('[data-artifact-id], .artifact-card, .question-artifact').length;
  return assistants > count || artifacts > 0;
}, beforeFollowup, { timeout: 120_000 });
await page.waitForTimeout(1500);
let followupText = await page.locator('.msg.assistant').last().innerText().catch(() => '');
let artifactCount = await page.locator('[data-artifact-id], .artifact-card, .question-artifact').count();
let questionExecutionStatus = null;
if (artifactCount === 0 && /现在开始吗|是否开始|确认/.test(followupText)) {
  const executionResponse = page.waitForResponse(response => /\/api\/chat\/tasks\/exam/.test(response.url()), { timeout: 120_000 }).catch(() => null);
  await page.locator('#input').fill('现在开始');
  await page.locator('#send').click();
  const response = await executionResponse;
  questionExecutionStatus = response?.status() ?? null;
  await page.waitForTimeout(1800);
  artifactCount = await page.locator('[data-artifact-id], .artifact-card, .question-artifact').count();
  followupText += `\n\n确认后：${await page.locator('.msg.assistant').last().innerText().catch(() => '')}`;
}
check('post-call-teaching-continues', followupText.trim().length >= 8 || artifactCount > 0, `${followupText.slice(0, 240)} | artifacts=${artifactCount}`);
check('post-call-question-artifact-created', artifactCount > 0 || (questionExecutionStatus >= 200 && questionExecutionStatus < 300), `${followupText.slice(0, 360)} | artifacts=${artifactCount} | exam_status=${questionExecutionStatus}`);
check('post-call-request-not-background-repeat', !/^\s*(你好|当然，让我们先了解)/.test(followupText), followupText.slice(0, 240));
await page.screenshot({ path: path.join(evidenceDir, '04-post-call-question.png'), fullPage: false });

check('real-provider-http-path-success', chatResponses.some(item => item.status >= 200 && item.status < 300), JSON.stringify(chatResponses));
check('no-console-errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('no-page-errors', pageErrors.length === 0, pageErrors.join(' | '));
check('no-server-errors', failedResponses.length === 0, JSON.stringify(failedResponses));

const failures = checks.filter(item => !item.pass);
const report = {
  status: failures.length ? 'FAIL' : 'PASS',
  generated_at: new Date().toISOString(),
  identity: { user_id: identity.user_id, username: identity.username },
  capabilities,
  expected_learning_node: expectedNode,
  bound_context: boundContext,
  final_call_state: await page.evaluate(() => window.KakiVoiceCallRuntime.getState()),
  assistant_answer_excerpt: assistantText.slice(0, 600),
  followup_answer_excerpt: followupText.slice(0, 600),
  artifact_count: artifactCount,
  question_execution_status: questionExecutionStatus,
  chat_responses: chatResponses,
  checks,
  failures,
  console_errors: consoleErrors,
  page_errors: pageErrors,
  failed_responses: failedResponses,
};
await writeFile(path.join(evidenceDir, 'voice-call-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (failures.length) process.exit(1);
