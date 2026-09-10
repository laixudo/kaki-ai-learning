import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const base = process.env.KAKI_STANDALONE || 'http://127.0.0.1:8765';
const evidenceDir = path.join(projectRoot, 'evidence/dynamic-adventure-10-browser-closeout-20260801');
const fixture = JSON.parse(await readFile(
  path.join(projectRoot, 'evidence/narrative-director-v020-three-students-20260801/three-students.json'),
  'utf8',
));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${base}/ai-workspace-test.html?v=standalone-score-fix-20260714`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.AIHarvestAdventure));

const presentations = await page.evaluate((records) => Object.fromEntries(
  Object.entries(records).map(([student, value]) => {
    const narrative = {
      world: {
        scene_id: value.scene_id,
        scene_name: value.scene_name,
        world_rule: value.world_rule,
      },
      recommended_destinations: [
        { scene_id: value.scene_id, reason: 'fixture-primary' },
        { scene_id: value.recommended[1], reason: 'fixture-secondary' },
      ],
      routes: {
        understanding: { action_frame: value.routes.understanding },
        practice: { action_frame: value.routes.practice },
      },
      state_copy: { opening: value.opening },
    };
    return [student, window.AIHarvestAdventure.presentationForNarrative(narrative, 'understanding')];
  }),
), fixture.narratives);

const values = Object.values(presentations);
const distinct = (key) => new Set(values.map((item) => item[key])).size;
const report = {
  status: distinct('primarySceneId') === 3
    && distinct('opening') === 3
    && distinct('routeActionFrame') === 3
    ? 'PASS'
    : 'FAIL',
  fixture: 'evidence/narrative-director-v020-three-students-20260801/three-students.json',
  distinct: {
    primaryScene: distinct('primarySceneId'),
    opening: distinct('opening'),
    routeActionFrame: distinct('routeActionFrame'),
  },
  presentations,
};

await writeFile(
  path.join(evidenceDir, 'three-students-front-consumption.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await browser.close();

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
