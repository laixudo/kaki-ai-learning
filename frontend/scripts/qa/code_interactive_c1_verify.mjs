import fs from 'node:fs';

const files = {
  shell: 'frontend/src/components/artifact/ArtifactShell.tsx',
  code: 'frontend/src/components/artifact/CodeRenderer.tsx',
  question: 'frontend/src/components/artifact/InteractiveQuestionRenderer.tsx',
  api: 'frontend/src/api/artifacts.ts',
  context: 'frontend/src/components/ai-learning/AiWorkspaceKernel.tsx',
};
const text = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, fs.readFileSync(path, 'utf8')]));
const checks = [
  ['ArtifactShell dispatches CodeRenderer', text.shell.includes('<CodeRenderer')],
  ['ArtifactShell dispatches InteractiveQuestionRenderer', text.shell.includes('<InteractiveQuestionRenderer')],
  ['Code run binds artifact version', text.code.includes('artifact_version_id: artifact.version_id')],
  ['Code run history filters exact version', text.code.includes('listCodeRuns(artifact.artifact_id, artifact.version_id)')],
  ['New code version uses expected version', text.code.includes('expected_version: artifact.version_number')],
  ['Code selection binds version', text.code.includes('artifact_version_id: artifact.version_id') && text.code.includes('section_anchor: `code-line-')],
  ['Process and observation are separate', text.code.includes('运行事实') && text.code.includes('学习观察')],
  ['Interactive submit sends no correctness', !/correct\s*:/.test(text.question.split('submitInteractiveAnswer', 2)[1]?.split('});', 1)[0] || '')],
  ['Interactive state restores from server', text.question.includes('getInteractiveState')],
  ['Interactive evaluation uses formal API', text.question.includes('learningEvaluatorApi.evaluate') && text.question.includes('learningEvaluatorApi.latest')],
  ['Question UI supports hint and solution separately', text.question.includes('requestInteractiveHint') && text.question.includes('viewInteractiveSolution')],
  ['A1 context integration remains present', text.context.includes('KakiWorkspaceContextBridge') && text.context.includes('onVersionSelected')],
  ['Code duplicate dispatch guarded', text.code.includes('runningRef.current') && text.code.includes('runIdentityRef.current')],
  ['Interactive duplicate dispatch guarded', text.question.includes('submittingRef.current') && text.question.includes('submissionIdentityRef.current')],
  ['Code API routes exact rerun path', text.api.includes('/api/chat/tasks/code/${artifactId}/rerun')],
  ['Interactive API routes exact attempts path', text.api.includes('/api/chat/tasks/presentations/${artifactId}/attempts')],
  ['Code run displays public version number', text.code.includes('selectedRun.artifact_version_number') && text.api.includes('artifact_version_number: number')],
  ['Interactive completion semantics are split', text.api.includes('answered_interactive_items') && text.api.includes('lesson_viewing_completed') && text.question.includes('本组互动题已作答')],
  ['Evaluator eligibility uses learner-facing language', text.question.includes('当前证据较充分') && !text.question.includes('你已经掌握') && !text.question.includes('学习节点已完成')],
  ['No remote renderer CDN', !Object.values(text).some(value => /https?:\/\//.test(value))],
];
let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}\t${name}`);
  if (!pass) failed += 1;
}
console.log(`SUMMARY\t${checks.length - failed}/${checks.length} PASS`);
process.exit(failed ? 1 : 0);
