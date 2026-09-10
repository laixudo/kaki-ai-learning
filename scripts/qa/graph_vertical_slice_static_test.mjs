import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, '../..');
const page = fs.readFileSync(path.join(root, 'frontend/src/pages/MyLearningPage.tsx'), 'utf8');
const api = fs.readFileSync(path.join(root, 'frontend/src/api/learningGraph.ts'), 'utf8');
const style = fs.readFileSync(path.join(root, 'frontend/src/pages/MyLearningPage.module.css'), 'utf8');
const resourceService = fs.readFileSync(path.join(root, 'backend/services/learning_graph_resource_generation.py'), 'utf8');
const tests = fs.readFileSync(path.join(root, 'backend/tests/test_learning_graph_resource_generation.py'), 'utf8');

const checks = [
  ['stable create identity is stored', page.includes('CREATE_IDENTITY_PREFIX') && page.includes('getStoredOperationIdentity(storageKey, \'learning-create\')')],
  ['create action is guarded', page.includes('if (creatingGraph || !createTitle.trim()) return;')],
  ['formal API preserves definitive response status', api.includes('export class GraphApiError') && api.includes('callWithUserError(() => postData<FormalGraphDetail>')],
  ['resource operation identity survives uncertain response', page.includes('RESOURCE_IDENTITY_PREFIX') && page.includes('retain the key when durable status cannot be confirmed')],
  ['durable generated state is recovered after an uncertain response', page.includes("durablePlan?.status === 'generated'")],
  ['durable failed state enables a fresh explicit retry', page.includes("durablePlan?.status === 'failed'") && page.includes('clearStoredOperationIdentity(storageKey)')],
  ['generating state is non-clickable', page.includes("plan.status === 'generating'") && page.includes('正在生成')],
  ['formal graph edges are visible', page.includes('incomingEdges') && page.includes('前置依赖')],
  ['resource replay binds thread and full aggregate identity', resourceService.includes('claimed.thread_id != thread_id') && resourceService.includes('different resource request')],
  ['thread mismatch regression test exists', tests.includes('test_execution_key_replay_rejects_a_different_thread_without_new_artifact_or_event')],
  ['notice has success and error visual states', style.includes('.formalNotice[data-tone="success"]') && style.includes('.formalNotice[data-tone="error"]')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
}
console.log(`SUMMARY ${checks.length - failed}/${checks.length} PASS`);
process.exitCode = failed ? 1 : 0;
