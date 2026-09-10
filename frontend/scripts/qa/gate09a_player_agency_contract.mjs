import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../public/ai-workspace/scripts/ai-workspace-adventure.js'), 'utf8');
const enemySource = fs.readFileSync(path.resolve(here, '../../public/ai-workspace/scripts/adventure-enemy-director.js'), 'utf8');

assert.match(source, /archive\.boss_ready/, 'the visible runtime must render the backend Boss-ready decision');
assert.match(source, /data-action="final-later"/, 'the player must be able to postpone final verification');
assert.match(source, /由你决定是否进入最终验证/, 'the decision copy must explicitly leave Boss entry to the player');
assert.match(source, /action === 'final-later'/, 'the postpone action must have a real click handler');
assert.match(enemySource, /next\.archive && next\.archive\.boss_ready/, 'ordinary enemy defeat must complete before the Boss decision');

console.log('gate09a player agency contract: PASS');
