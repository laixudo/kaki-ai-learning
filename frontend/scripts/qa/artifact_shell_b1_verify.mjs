import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];
function check(id, condition, detail) { checks.push({ id, pass: Boolean(condition), detail }); }

const shell = read('frontend/src/components/artifact/ArtifactShell.tsx');
const renderer = read('frontend/src/components/artifact/DocumentRenderer.tsx');
const detail = read('frontend/src/pages/ArtifactDetailPage.tsx');
const learning = read('frontend/src/pages/MyLearningPage.tsx');
const kernel = read('frontend/src/components/ai-learning/AiWorkspaceKernel.tsx');
const harness = read('frontend/public/ai-workspace/scripts/ai-workspace-harness.js');
const context = read('frontend/public/ai-workspace/scripts/ai-workspace-context.js');
const integration = read('frontend/public/ai-workspace/scripts/ai-workspace-context-integration.js');
const api = read('frontend/src/api/artifacts.ts');
const backend = read('backend/services/workspace_artifact_versions.py');

check('shared-shell-detail', detail.includes('<ArtifactShell'), '/artifacts/:id mounts ArtifactShell');
check('shared-shell-learning', learning.includes('<ArtifactShell') && !learning.includes('className={styles.artifactContent}'), '/learning mounts ArtifactShell and removes pre viewer');
check('shared-shell-ai', kernel.includes('<ArtifactShell') && harness.includes('KakiArtifactShellHost'), '/ai-learning uses React ArtifactShell host through compatibility adapter');
check('one-public-api', api.includes('/api/items/${artifactId}') && api.includes('/versions') && api.includes('/compare'), 'one existing item API family');
check('immutable-version-ux', shell.includes('旧版没有被覆盖') && shell.includes('切换到 v'), 'new version does not silently switch viewed version');
check('selection-version-bound', renderer.includes('artifact_version_id: artifact.version_id') && integration.includes('version_id'), 'selection binds durable version id');
check('reading-position-version-bound', shell.includes('threadId ||') && shell.includes('artifact.version_id'), 'reading position key includes thread, artifact and version');
check('safe-renderer', !renderer.includes('dangerouslySetInnerHTML') && !shell.includes('dangerouslySetInnerHTML'), 'no raw model HTML execution');
check('no-remote-renderer', !shell.match(/https?:\/\//) && !renderer.match(/https?:\/\//), 'no remote renderer/CDN');
check('semantic-blocks', ['table','formula','code','callout','ordered','unordered'].every(token => renderer.includes(`type: '${token}'`)), 'document semantic blocks present');
check('focus-and-narrow', shell.includes('focusMode') && read('frontend/src/components/artifact/ArtifactShell.module.css').includes('@media(max-width:800px)'), 'focus and narrow layout present');
check('version-compare', shell.includes('VersionComparisonView') && shell.includes('新增') && shell.includes('删除') && shell.includes('修改'), 'semantic version diff UX present');
check('public-privacy', backend.includes('_FORBIDDEN_KEYS') && backend.includes('public_data_snapshot'), 'server public projection strips private keys');
check('context-version-id', context.includes('version_id: versionId') && integration.includes('target.version_id || target.version'), 'A1 context uses durable version id with compatibility fallback');
check('legacy-readonly', ![shell, renderer, detail, learning, kernel, harness, context, integration, api].some(source => source.includes('app.html#tutor')), 'B1 adds no legacy tutor implementation or route');

const failed = checks.filter(item => !item.pass);
console.log(JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
if (failed.length) process.exit(1);
