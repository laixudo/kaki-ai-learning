import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const password = process.env.KAKI_PASSWORD || 'KakiTask15!2026';
const evidence = path.resolve('..', 'evidence', '15');
const users = JSON.parse(await readFile(path.join(evidence, 'task15-test-users.json'), 'utf8'));
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: users.a.username, password }) });
if (!login.ok) throw new Error(`login ${login.status}`);
const identity = (await login.json()).data;
const phrase = '请用一句话解释函数单调性';
const speech = await fetch(`${base}/api/video/speech`, { method: 'POST', headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: phrase, voice: 'zh-CN-XiaoxiaoNeural' }) });
if (!speech.ok) throw new Error(`tts ${speech.status}`);
const bytes = Buffer.from(await speech.arrayBuffer());
const audioPath = path.join(evidence, 'voice-permission', 'asr-roundtrip-real-edge-tts.mp3');
await writeFile(audioPath, bytes);
const form = new FormData();
form.set('file', new Blob([bytes], { type: 'audio/mpeg' }), 'task15-real-edge-tts.mp3');
const started = Date.now();
const transcribe = await fetch(`${base}/api/chat/input/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${identity.token}` }, body: form });
const payload = await transcribe.json().catch(() => null);
const transcript = String(payload?.data?.text || payload?.text || '').trim();
const report = {
  generated_at: new Date().toISOString(),
  status: transcribe.ok && transcript.length > 0 ? 'PASS' : 'FAIL',
  classification: 'REAL_ASR_PROVIDER_FILE_ROUNDTRIP_NOT_PHYSICAL_MIC_SPEECH',
  source: { provider: 'Edge TTS formal endpoint', phrase, bytes: bytes.length, file: audioPath },
  transcribe: { http_status: transcribe.status, elapsed_ms: Date.now() - started, transcript }
};
await writeFile(path.join(evidence, 'tests', 'real-asr-provider-roundtrip.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 1);
