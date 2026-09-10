import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.KAKI_FRONTEND || 'http://127.0.0.1:5174';
const username = process.env.KAKI_USER || 'browsertest';
const password = process.env.KAKI_PASSWORD || 'test1234';
const projectRoot = path.resolve('..');
const evidenceDir = process.env.KAKI_MASCOT_EVIDENCE
  || path.join(projectRoot, 'evidence', 'mascot-companion-20260731');
const assetRoot = path.resolve('public', 'ai-workspace', 'assets', 'avatars');
const sourceRoot = path.resolve('src', 'features', 'mascot');

await mkdir(evidenceDir, { recursive: true });

const checks = [];
const screenshots = [];
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];

function check(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail });
  if (!pass) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

function intersects(a, b) {
  return Boolean(a && b
    && a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y);
}

async function capture(page, name) {
  const file = path.join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  screenshots.push(file);
}

async function login(context) {
  let response = await context.request.post(`${base}/api/auth/login`, {
    data: { username, password }
  });
  if (!response.ok()) {
    const acceptanceUser = `mascot_accept_${Date.now()}`;
    const acceptancePassword = 'Mascot!20260731';
    response = await context.request.post(`${base}/api/auth/register`, {
      data: { username: acceptanceUser, password: acceptancePassword }
    });
    if (!response.ok()) {
      const errorBody = await response.text();
      check('real-registration-http-200', false, `${response.status()} ${errorBody}`);
    }
    check('real-registration-http-200', true, String(response.status()));
  }
  if (!response.ok()) {
    const errorBody = await response.text();
    check('real-auth-http-200', false, `${response.status()} ${errorBody}`);
  }
  check('real-auth-http-200', true, String(response.status()));
  const payload = await response.json();
  const data = payload.data;
  check('real-auth-token-present', Boolean(data?.token));
  const headers = { Authorization: `Bearer ${data.token}` };
  const onboarding = await context.request.post(`${base}/api/profile-onboarding/start`, { headers });
  if (onboarding.ok()) {
    const onboardingPayload = await onboarding.json();
    const taskId = onboardingPayload.data?.task_id ?? onboardingPayload.task_id;
    if (taskId) {
      const skipped = await context.request.post(`${base}/api/profile-onboarding/skip`, {
        headers,
        data: { task_id: taskId }
      });
      if (!skipped.ok()) {
        const errorBody = await skipped.text();
        check('real-profile-ready', false, `${skipped.status()} ${errorBody}`);
      }
      check('real-profile-ready', true, String(skipped.status()));
    }
  }
  return {
    token: data.token,
    user: {
      userId: data.user_id,
      username: data.username,
      email: data.email ?? null,
      avatarUrl: data.avatar_url ?? null,
      hasProfile: true
    }
  };
}

async function installSession(page, session) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('auth_token', token);
    localStorage.setItem('ml_auth_token', token);
    localStorage.setItem('kaki_user', JSON.stringify(user));
    localStorage.setItem('ml_current_user_id', String(user.userId));
    localStorage.setItem('kaki_profile_status', 'complete');
  }, session);
}

async function readAlphaCorners(page, source) {
  return page.evaluate(async (src) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = src;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const points = [
      [0, 0],
      [image.naturalWidth - 1, 0],
      [0, image.naturalHeight - 1],
      [image.naturalWidth - 1, image.naturalHeight - 1]
    ];
    return points.map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]);
  }, source);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1
});
const session = await login(context);
const page = await context.newPage();
page.setDefaultTimeout(45_000);
await installSession(page, session);
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 500) failedResponses.push({ status: response.status(), url: response.url() });
});

await page.goto(`${base}/`, { waitUntil: 'networkidle' });
const mascot = page.getByTestId('mascot-companion');
await mascot.waitFor({ state: 'visible' });
check('single-global-instance', await page.getByTestId('mascot-companion').count() === 1);
check('official-sprite-mounted', await mascot.getAttribute('data-asset') === 'kaki-tutor-sprite');
check('default-state-is-stable', ['appearing', 'idle', 'blinking', 'looking', 'waving'].includes(await mascot.getAttribute('data-state')));
check('keyboard-focusable', await mascot.getAttribute('tabindex') === '0');
check('companion-has-accessible-label', Boolean(await mascot.getAttribute('aria-label')));

const defaultBox = await mascot.boundingBox();
const topbarBox = await page.getByTestId('app-topbar').boundingBox();
const footerBox = await page.locator('footer').boundingBox();
check('default-position-inside-viewport', defaultBox
  && defaultBox.x >= 0
  && defaultBox.y >= 0
  && defaultBox.x + defaultBox.width <= 1920
  && defaultBox.y + defaultBox.height <= 1080);
check('default-position-avoids-fixed-chrome', !intersects(defaultBox, topbarBox) && !intersects(defaultBox, footerBox));
check('no-horizontal-scroll-1920', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await capture(page, '01-default-companion-1920x1080');

const dailyAlpha = await readAlphaCorners(page, '/ai-workspace/assets/avatars/kaki-tutor-sprite.png');
const celebrationAlpha = await readAlphaCorners(page, '/ai-workspace/assets/avatars/kaki-companion-celebration.png');
check('daily-asset-transparent-corners', dailyAlpha.every((alpha) => alpha === 0), dailyAlpha.join(','));
check('celebration-asset-transparent-corners', celebrationAlpha.every((alpha) => alpha === 0), celebrationAlpha.join(','));

const center = {
  x: defaultBox.x + defaultBox.width / 2,
  y: defaultBox.y + defaultBox.height / 2
};
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(170, 440, { steps: 8 });
check('drag-state-visible', await mascot.getAttribute('data-state') === 'dragging');
await capture(page, '02-dragging-companion');
await page.mouse.up();
await page.waitForTimeout(700);
const snappedBox = await mascot.boundingBox();
check('snaps-to-left-edge', snappedBox && snappedBox.x <= 28, JSON.stringify(snappedBox));
check('drag-remains-in-viewport', snappedBox && snappedBox.y >= 72 && snappedBox.y + snappedBox.height <= 1040);
check('position-persisted', await page.evaluate((userId) => Boolean(localStorage.getItem(`kaki_mascot_companion_v1:${userId}`)), session.user.userId));
await capture(page, '03-left-edge-snap');

await page.reload({ waitUntil: 'networkidle' });
await mascot.waitFor({ state: 'visible' });
const restoredBox = await mascot.boundingBox();
check('position-restored-after-refresh', restoredBox && restoredBox.x <= 28, JSON.stringify(restoredBox));

await mascot.press('Enter');
await page.getByTestId('mascot-move-right').click();
await page.waitForTimeout(500);
const keyboardMovedBox = await mascot.boundingBox();
check('keyboard-move-right-works', keyboardMovedBox && keyboardMovedBox.x > 1500, JSON.stringify(keyboardMovedBox));
await mascot.press('Escape');
await page.waitForTimeout(3_000);

await page.getByRole('link', { name: '学习笔记' }).click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(900);
check('route-awareness-page-key', await mascot.getAttribute('data-page-key') === 'notes');
const routeBubble = page.getByTestId('mascot-bubble');
check('route-bubble-visible', await routeBubble.isVisible());
const routeBubbleBox = await routeBubble.boundingBox();
check('route-bubble-inside-viewport', routeBubbleBox
  && routeBubbleBox.x >= 8
  && routeBubbleBox.y >= 8
  && routeBubbleBox.x + routeBubbleBox.width <= 1912
  && routeBubbleBox.y + routeBubbleBox.height <= 1072);
await capture(page, '04-notes-route-awareness');

await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('kaki:digital-tutor-state', {
    detail: { state: 'thinking', previousState: 'idle', subtitle: '正在整理真实学习任务。' }
  }));
});
await page.waitForTimeout(120);
check('real-state-bridge-thinking', await mascot.getAttribute('data-state') === 'thinking');
await capture(page, '05-thinking-event-response');

await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('kaki:digital-tutor-state', {
    detail: { state: 'correction', previousState: 'thinking', subtitle: '这次没有成功，可以重试。' }
  }));
});
await page.waitForTimeout(120);
check('failure-does-not-celebrate', await mascot.getAttribute('data-state') === 'reacting');

await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('kaki:mascot-event', {
    detail: { type: 'assessment.completed', importance: 'milestone', message: '这一程也有好好前进呀。' }
  }));
});
await page.waitForTimeout(120);
check('milestone-starts-celebration', await mascot.getAttribute('data-state') === 'celebrating');
check('celebration-uses-dedicated-asset', await mascot.getAttribute('data-asset') === 'kaki-companion-celebration');
const iterationCount = await mascot.locator('[data-testid="mascot-visual"]').evaluate((node) => getComputedStyle(node).animationIterationCount);
check('celebration-does-not-loop-forever', iterationCount === '1', iterationCount);
await capture(page, '06-bouquet-celebration');

await mascot.press('Enter');
await page.getByTestId('mascot-pause').click();
check('pause-control-sets-quiet-mode', await mascot.getAttribute('data-quiet') === 'true');
await mascot.press('Enter');
await page.getByTestId('mascot-resume').click();
check('resume-control-restores-companion', await mascot.getAttribute('data-quiet') === 'false');

await page.setViewportSize({ width: 1366, height: 768 });
await page.waitForTimeout(500);
const compactBox = await mascot.boundingBox();
check('responsive-position-inside-1366', compactBox
  && compactBox.x >= 0
  && compactBox.y >= 64
  && compactBox.x + compactBox.width <= 1366
  && compactBox.y + compactBox.height <= 730,
JSON.stringify(compactBox));
check('no-horizontal-scroll-1366', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await capture(page, '07-safe-layout-1366x768');

await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${base}/ai-learning`, { waitUntil: 'networkidle' });
await page.locator('#adventureEntry').waitFor({ state: 'visible' });
const assistantCountBeforeChat = await page.locator('#messages .msg.assistant').count();
await page.locator('#input').fill('请用一句话说明验证集与测试集的区别。');
const chatResponsePromise = page.waitForResponse(
  (response) => response.url().includes('/api/chat') && response.request().method() === 'POST',
  { timeout: 120_000 }
);
await page.locator('#send').click();
const chatResponse = await chatResponsePromise;
await page.waitForFunction(
  (count) => document.querySelectorAll('#messages .msg.assistant').length > count
    && !document.querySelector('#send')?.disabled,
  assistantCountBeforeChat,
  { timeout: 120_000 }
);
const latestAssistantText = await page.locator('#messages .msg.assistant').last().innerText();
check(
  'ordinary-ai-chat-real-stream-and-answer',
  chatResponse.status() === 200 && latestAssistantText.trim().length >= 8,
  `status=${chatResponse.status()} answerLength=${latestAssistantText.trim().length}`
);
await page.locator('#adventureEntry').click();
// Real product flow: entry click prepares a journey (real LLM, ~20s) and shows the
// prepare card; starting from the card opens the overlay. With an active journey the
// overlay opens directly.
const overlayLoc = page.locator('.shiguang-overlay');
const prepareCardLoc = page.locator('#adventurePrepare:not([hidden])');
await Promise.race([
  overlayLoc.waitFor({ state: 'visible' }),
  prepareCardLoc.waitFor({ state: 'visible' })
]);
if (await prepareCardLoc.isVisible().catch(() => false)) {
  await page.locator('#adventurePrepareStart').click();
}
await overlayLoc.waitFor({ state: 'visible' });
await page.waitForTimeout(300);
check('global-companion-hidden-in-game', await mascot.getAttribute('data-state') === 'hidden');
check('game-has-one-in-world-mascot', await page.locator('.shiguang-overlay img[src*="mascot_shixiaoji"]').count() === 1);
await capture(page, '08-game-role-handoff');
await page.locator('[data-action="leave"]').click();
await page.waitForTimeout(500);
check('global-companion-restored-after-game', await mascot.isVisible() && await mascot.getAttribute('data-state') !== 'hidden');

const reducedContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce'
});
const reducedPage = await reducedContext.newPage();
await installSession(reducedPage, session);
await reducedPage.goto(`${base}/`, { waitUntil: 'networkidle' });
const reducedMascot = reducedPage.getByTestId('mascot-companion');
await reducedMascot.waitFor({ state: 'visible' });
await reducedPage.evaluate(() => {
  window.dispatchEvent(new CustomEvent('kaki:mascot-event', {
    detail: { type: 'assessment.completed', importance: 'milestone', message: '这一程也有好好前进呀。' }
  }));
});
await reducedPage.waitForTimeout(100);
const reducedAnimation = await reducedMascot.locator('[data-testid="mascot-visual"]').evaluate((node) => getComputedStyle(node).animationName);
check('reduced-motion-removes-spin', !reducedAnimation.includes('celebrateSpin'), reducedAnimation);
await capture(reducedPage, '09-reduced-motion-celebration');
await reducedContext.close();

check('no-console-errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('no-page-errors', pageErrors.length === 0, pageErrors.join(' | '));
check('no-5xx-responses', failedResponses.length === 0, JSON.stringify(failedResponses));

const resourcePaths = [
  path.join(assetRoot, 'kaki-tutor-sprite.png'),
  path.join(assetRoot, 'kaki-companion-celebration.png')
];
const resources = [];
for (const file of resourcePaths) {
  const buffer = await readFile(file);
  const info = await stat(file);
  resources.push({
    path: path.relative(projectRoot, file).split(path.sep).join('/'),
    purpose: file.includes('celebration') ? 'milestone celebration' : 'daily companion sprite atlas',
    dimensions: file.includes('celebration') ? '1228x1280' : '1400x1120',
    format: 'PNG',
    bytes: info.size,
    transparent: true,
    source: file.includes('celebration') ? 'generated from user-approved official JPG reference' : 'existing formal project asset',
    sha256: createHash('sha256').update(buffer).digest('hex')
  });
}

const resourceManifestPath = path.join(evidenceDir, 'mascot-resource-manifest.json');
await writeFile(resourceManifestPath, `${JSON.stringify({ resources }, null, 2)}\n`, 'utf8');
const report = {
  status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL',
  total: checks.length,
  passed: checks.filter((item) => item.pass).length,
  failed: checks.filter((item) => !item.pass),
  checks,
  screenshots,
  resourceManifest: resourceManifestPath,
  consoleErrors,
  pageErrors,
  failedResponses
};
await writeFile(path.join(evidenceDir, 'mascot-companion-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
await context.close();
await browser.close();
