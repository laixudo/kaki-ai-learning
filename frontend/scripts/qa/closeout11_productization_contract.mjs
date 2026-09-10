import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const base = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
const username = process.env.KAKI_USER;
const password = process.env.KAKI_PASSWORD;
if (!username || !password) throw new Error('KAKI_USER and KAKI_PASSWORD are required');

const browser = await chromium.launch({ headless: true });
const loginContext = await browser.newContext();
const response = await loginContext.request.post(`${base}/api/auth/login`, { data: { username, password } });
if (!response.ok()) throw new Error(`login failed with HTTP ${response.status()}`);
const auth = (await response.json()).data;
await loginContext.close();

const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await context.addInitScript(({ token, userId, currentUsername }) => {
  const user = { userId, username: currentUsername, hasProfile: true };
  localStorage.setItem('token', token);
  localStorage.setItem('auth_token', token);
  localStorage.setItem('ml_auth_token', token);
  localStorage.setItem('kaki_user', JSON.stringify(user));
  localStorage.setItem('ml_current_user_id', String(userId));
  localStorage.setItem('kaki_profile_status', 'complete');
}, { token: auth.token, userId: auth.user_id, currentUsername: auth.username });

const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

await page.goto(`${base}/resources`, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="module-page-resources"]').waitFor();
await page.waitForTimeout(500);
const resources = await page.evaluate(() => {
  const title = document.querySelector('[data-testid="module-page-resources"] h1');
  const rect = title?.getBoundingClientRect();
  return { width: rect?.width || 0, height: rect?.height || 0, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
});

await page.goto(`${base}/notes`, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="notes-page"]').waitFor();
await page.waitForTimeout(500);
const notes = await page.evaluate(() => {
  const root = document.querySelector('[data-testid="notes-page"]');
  const left = root?.children[0]?.getBoundingClientRect();
  const middle = root?.children[1]?.getBoundingClientRect();
  const right = root?.children[2]?.getBoundingClientRect();
  return {
    direction: root ? getComputedStyle(root).flexDirection : '',
    rootWidth: root?.getBoundingClientRect().width || 0,
    leftWidth: left?.width || 0,
    middleWidth: middle?.width || 0,
    rightWidth: right?.width || 0,
    middleLeft: middle?.left || 0,
    rightLeft: right?.left || 0,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

await page.goto(`${base}/ai-learning`, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="ai-learning-page"]').waitFor();
await page.waitForTimeout(800);
const workspace = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('.mode-card')).map((node) => node.getBoundingClientRect().width);
  return { cardWidths: cards, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
});

const notesSource = await readFile(new URL('../../src/pages/NotesPage.tsx', import.meta.url), 'utf8');
const learningSource = await readFile(new URL('../../src/pages/MyLearningPage.tsx', import.meta.url), 'utf8');
const checks = {
  resourceTitleReadable: resources.width >= 120 && resources.height <= 64,
  resourceNoHorizontalOverflow: resources.overflow <= 2,
  notesUseMobileFlow: notes.direction === 'column',
  notesPanelsRemainReadable: [notes.leftWidth, notes.middleWidth, notes.rightWidth].every((width) => width >= 260),
  notesNoHorizontalOverflow: notes.overflow <= 2,
  workspaceModeCardsReadable: workspace.cardWidths.length === 0 || workspace.cardWidths.every((width) => width >= 220),
  workspaceNoHorizontalOverflow: workspace.overflow <= 2,
  notesSupportsSelectionApply: notesSource.includes('note-ai-replace-selection'),
  notesSupportsRegenerate: notesSource.includes('note-ai-regenerate'),
  learningShowsNextCandidates: learningSource.includes('learning-next-candidates'),
  learningShowsRecentChanges: learningSource.includes('learning-recent-changes'),
  learningGraphIsOnDemand: learningSource.includes('learning-graph-toggle'),
  noConsoleOrPageErrors: errors.length === 0,
};
const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures, resources, notes, workspace, errors }, null, 2));
await browser.close();
if (failures.length) process.exit(1);
