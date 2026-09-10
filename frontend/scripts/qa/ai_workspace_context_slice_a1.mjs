import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../../public/ai-workspace/scripts/ai-workspace-context.js'), 'utf8');
const sandbox = { globalThis: {} };
sandbox.window = sandbox.globalThis;
vm.runInNewContext(source, sandbox, { filename: 'ai-workspace-context.js' });
const contextApi = sandbox.globalThis.AIWorkspaceContext;

class MemoryStorage {
  constructor() { this.rows = new Map(); }
  getItem(key) { return this.rows.has(key) ? this.rows.get(key) : null; }
  setItem(key, value) { this.rows.set(key, String(value)); }
  removeItem(key) { this.rows.delete(key); }
}

const sessionStorage = new MemoryStorage();
const localStorage = new MemoryStorage();
const environment = { sessionStorage, localStorage };
const controller = contextApi.createController({ environment });

controller.load('thread-a');
assert.equal(controller.getState().primary_object, null);
controller.bindArtifact({ artifact_id: 101, kind: 'code', title: '代码实验', version: 2, graph_id: 'graph-a', graph_node_id: 'node-a' }, { source: 'artifact_opened' });
controller.bindArtifact({ artifact_id: 102, kind: 'lecture', title: '学习讲义', version: 1, graph_id: 'graph-a', graph_node_id: 'node-a' }, { source: 'artifact_opened' });
let state = controller.getState();
assert.equal(state.primary_object.artifact_id, 102);
assert.equal(state.reference_objects.length, 1);
assert.equal(state.reference_objects[0].artifact_id, 101);

controller.switchPrimary('artifact:101:v2');
state = controller.getState();
assert.equal(state.primary_object.artifact_id, 101);
assert.equal(state.reference_objects[0].artifact_id, 102);

controller.setSelection({ summary: 'learning_rate = 0.9', range_label: '代码第 14 行', purpose: '解释选中内容' });
assert.equal(controller.getState().selection_ref.summary, 'learning_rate = 0.9');
assert.equal(controller.deriveActions().length, 3);
assert.equal(controller.deriveActions()[0].source, 'CONTEXT_DERIVED');

controller.setQuietMode(true);
assert.equal(controller.getState().quiet_mode, true);
controller.removeObject('artifact:101:v2');
state = controller.getState();
assert.equal(state.primary_object, null, 'removing the primary must not secretly promote the latest reference');
assert.equal(state.reference_objects.length, 1);

controller.load('thread-b');
assert.equal(controller.getState().primary_object, null, 'context is isolated per thread');
controller.load('thread-a');
state = controller.getState();
assert.equal(state.primary_object, null);
assert.equal(state.reference_objects[0].artifact_id, 102);
assert.equal(state.quiet_mode, true, 'quiet mode is a user preference shared across threads');

controller.setTask({ status: 'failed' });
const failedActions = controller.deriveActions();
assert.ok(failedActions.length <= 3);
assert.equal(new Set(failedActions.map((item) => item.id)).size, failedActions.length, 'failed actions must not be duplicated');

controller.destroy();
console.log(JSON.stringify({ status: 'PASS', assertions: 16, context_state_version: contextApi.STATE_VERSION }));
