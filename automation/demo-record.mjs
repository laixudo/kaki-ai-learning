import { spawnSync } from 'node:child_process';
import path from 'node:path';

const rehearsal = process.argv.includes('--rehearsal');
const extra = rehearsal ? ['--rehearsal'] : [];

for (const script of ['full-demo.mjs', 'highlight-demo.mjs']) {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, script), ...extra], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(rehearsal ? 'ALL_REHEARSALS_PASS' : 'ALL_DEMO_VIDEOS_READY');
