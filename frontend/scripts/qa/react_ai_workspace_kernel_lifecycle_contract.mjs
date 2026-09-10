import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const kernelUrl = new URL(
  '../../src/components/ai-learning/AiWorkspaceKernel.tsx',
  import.meta.url,
);
const source = readFileSync(fileURLToPath(kernelUrl), 'utf8');
const globalsBlock = source.match(
  /const SCRIPT_GLOBALS = \[([\s\S]*?)\] as const;/,
);

assert.ok(globalsBlock, 'AiWorkspaceKernel SCRIPT_GLOBALS was not found');

const globals = Array.from(
  globalsBlock[1].matchAll(/['"]([^'"]+)['"]/g),
  (match) => match[1],
);

assert.ok(
  globals.includes('apiClient'),
  'SCRIPT_GLOBALS must clean up the apiClient alias',
);
assert.ok(
  globals.includes('AIWorkspaceApiClient'),
  'SCRIPT_GLOBALS must clean up the AIWorkspaceApiClient alias',
);

process.stdout.write(
  `${JSON.stringify({
    status: 'passed',
    assertion: 'both AI workspace API client aliases are cleaned up',
    globals,
  })}\n`,
);
