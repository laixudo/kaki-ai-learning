import { request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const output = process.env.KAKI_EVIDENCE || path.resolve('evidence/08/prepare-idempotency');
await mkdir(output, { recursive: true });

const api = await request.newContext({ baseURL: base });
const stamp = Date.now();
const username = `ultimate08_prepare_${stamp}`;
const password = 'PrepareReplay!2026';
const register = await api.post('/api/auth/register', {
  data: { username, password, email: `${username}@example.test` },
});
if (!register.ok()) throw new Error(`register ${register.status()}: ${await register.text()}`);
const account = (await register.json()).data;
const headers = { Authorization: `Bearer ${account.token}` };
const intent = {
  topic_hint: '为什么阴影边缘有时柔和、有时清晰',
  thread_id: `ultimate08-prepare-${stamp}`,
  source_ids: [],
};

async function prepare() {
  const response = await api.post('/api/adventure/prepare', { headers, data: intent, timeout: 120_000 });
  const body = await response.json();
  if (!response.ok()) throw new Error(`prepare ${response.status()}: ${JSON.stringify(body)}`);
  return body.data;
}

const startedAt = Date.now();
const first = await prepare();
const firstMs = Date.now() - startedAt;
const replayStartedAt = Date.now();
const second = await prepare();
const replayMs = Date.now() - replayStartedAt;
const currentResponse = await api.get('/api/adventure/prepare/current', { headers });
const current = (await currentResponse.json()).data;

const result = {
  status: first.plan_id === second.plan_id
    && second.idempotent_replay === true
    && current?.plan_id === first.plan_id ? 'PASS' : 'FAIL',
  same_plan_id: first.plan_id === second.plan_id,
  replay_declared: second.idempotent_replay === true,
  current_matches: current?.plan_id === first.plan_id,
  first_duration_ms: firstMs,
  replay_duration_ms: replayMs,
  plan_id: first.plan_id,
  topic: intent.topic_hint,
};
await writeFile(path.join(output, 'prepare-idempotency-live.json'), JSON.stringify(result, null, 2), 'utf8');
await api.dispose();
console.log(JSON.stringify(result));
if (result.status !== 'PASS') process.exitCode = 1;
