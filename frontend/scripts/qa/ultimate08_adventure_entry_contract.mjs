import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const pageSource = await readFile(new URL('src/pages/AiLearningPage.tsx', root), 'utf8');
const workspaceSource = await readFile(new URL('public/ai-workspace/ai-workspace-test.html', root), 'utf8');
const adventureSource = await readFile(new URL('public/ai-workspace/scripts/ai-workspace-adventure.js', root), 'utf8');
const combined = `${pageSource}\n${workspaceSource}`;

const checks = [
  ['removes fake single-character icon block', !combined.includes('adventure-entry-mark') && !/>\s*卷\s*</.test(workspaceSource)],
  ['removes generic right-arrow affordance', !combined.includes('adventure-entry-arrow')],
  ['uses an existing formal Adventure scene asset', combined.includes('/ai-workspace/assets/adventure/scenes/scene_camp_prepare.png')],
  ['provides a real image with empty decorative alt', /<img[^>]+adventure-entry-scene[^>]+alt=""/.test(workspaceSource)],
  ['exposes a current-topic text target', workspaceSource.includes('data-adventure-topic')],
  ['resume state writes a real current topic', /querySelector\('\[data-adventure-topic\]'\)/.test(adventureSource) && /current\.(topic|title)/.test(adventureSource)],
  ['uses a named action instead of an icon-only arrow', /进入旅程/.test(workspaceSource)],
  ['does not use emoji as the prepare visual', !workspaceSource.includes('adventure-prepare-icon') && !workspaceSource.includes('✨')],
];

const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) {
  console.error(`ULTIMATE-08 Adventure entry contract failed: ${failed.join('; ')}`);
  process.exit(1);
}
