import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

export const projectRoot = path.resolve(import.meta.dirname, '..');
export const outputDir = path.join(projectRoot, 'output', 'demo-video');
export const rawDir = path.join(outputDir, 'raw');
export const reportDir = path.join(outputDir, 'reports');
export const baseUrl = process.env.KAKI_BASE_URL || 'http://127.0.0.1:5174';
export const videoSize = { width: 1440, height: 900 };
export const sessionPath = path.join(outputDir, '.demo-session.json');
export const requireFromFrontend = createRequire(path.join(projectRoot, 'frontend', 'package.json'));
export const { chromium } = requireFromFrontend('@playwright/test');

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureOutputDirs() {
  await Promise.all([outputDir, rawDir, reportDir].map((dir) => mkdir(dir, { recursive: true })));
}

export function naturalSteps(from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.max(15, Math.min(30, Math.round(distance / 32)));
}

export function createHumanDriver(page) {
  let pointer = { x: videoSize.width * 0.68, y: videoSize.height * 0.72 };
  async function move(locator, options = {}) {
    await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 45_000 });
    const box = await locator.boundingBox();
    if (!box) throw new Error('目标控件没有可用的屏幕位置');
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(target.x, target.y, { steps: naturalSteps(pointer, target) });
    pointer = target;
    await pause(options.before ?? 420);
  }
  async function click(locator, options = {}) {
    await move(locator, options);
    await locator.click({ timeout: options.timeout ?? 45_000 });
    await pause(options.after ?? 850);
  }
  async function type(locator, value, options = {}) {
    await click(locator, { before: options.before ?? 350, after: 180, timeout: options.timeout });
    if (options.clear !== false) {
      await locator.press('Control+A');
      await locator.press('Backspace');
    }
    await locator.pressSequentially(value, { delay: options.delay ?? 28 });
    await pause(options.after ?? 450);
  }
  async function scroll(total, step = 420) {
    const direction = Math.sign(total) || 1;
    let remaining = Math.abs(total);
    while (remaining > 0) {
      const delta = direction * Math.min(step, remaining);
      await page.mouse.wheel(0, delta);
      remaining -= Math.abs(delta);
      await pause(520);
    }
  }
  async function wander(index = 0) {
    const points = [
      { x: 860, y: 280 }, { x: 1050, y: 540 }, { x: 720, y: 660 }, { x: 1180, y: 340 },
    ];
    const target = points[index % points.length];
    await page.mouse.move(target.x, target.y, { steps: naturalSteps(pointer, target) });
    pointer = target;
  }
  return { move, click, type, scroll, wander };
}

export async function holdUntil(page, human, startedAt, targetSeconds) {
  let index = 0;
  while (Date.now() - startedAt < targetSeconds * 1000) {
    const remaining = targetSeconds * 1000 - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await human.wander(index++).catch(() => {});
    await page.waitForTimeout(Math.min(5_000, Math.max(300, remaining)));
  }
}

export async function openLearningTool(page, human, label) {
  if (!page.url().includes('/ai-learning')) {
    const back = page.getByRole('button', { name: '回到对话', exact: true });
    if (await back.isVisible().catch(() => false)) await human.click(back);
    else await page.goto(`${baseUrl}/ai-learning`, { waitUntil: 'domcontentloaded' });
  }
  await page.locator('#input').waitFor({ state: 'visible', timeout: 45_000 });
  await human.click(page.getByTestId('learning-tool-composer-trigger'));
  const tray = page.getByTestId('learning-tool-tray');
  await tray.waitFor({ state: 'visible' });
  await human.click(tray.getByRole('button', { name: label, exact: true }));
}

export async function backToAi(page, human) {
  if (page.url().includes('/ai-learning')) return;
  const back = page.getByRole('button', { name: '回到对话', exact: true });
  if (await back.isVisible().catch(() => false)) await human.click(back);
  else await page.goto(`${baseUrl}/ai-learning`, { waitUntil: 'domcontentloaded' });
  await page.locator('#input').waitFor({ state: 'visible', timeout: 45_000 });
}

export async function waitForAssistant(page, previousCount, timeout = 180_000) {
  await page.waitForFunction((count) => {
    const nodes = document.querySelectorAll('#messages .msg.assistant .message-bubble');
    const stop = document.querySelector('#stop');
    const send = document.querySelector('#send');
    const last = nodes[nodes.length - 1];
    return nodes.length > count
      && Boolean(last?.textContent?.trim().length > 16)
      && Boolean(!stop || stop.hidden)
      && Boolean(!send || !send.disabled);
  }, previousCount, { timeout });
  return page.locator('#messages .msg.assistant .message-bubble').last().innerText();
}

export async function sendChat(page, human, text, timeout = 180_000) {
  const previous = await page.locator('#messages .msg.assistant .message-bubble').count();
  await human.type(page.locator('#input'), text, { delay: 22 });
  await human.click(page.locator('#send'), { after: 650 });
  return waitForAssistant(page, previous, timeout);
}

export async function readSession() {
  return JSON.parse(await readFile(sessionPath, 'utf8'));
}

export async function writeSession(session) {
  await ensureOutputDirs();
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    'C:\\Program Files\\AigcPanel\\resources\\extra\\win-x86\\ffmpeg.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'ffmpeg-1011', 'ffmpeg-win64.exe') : '',
    'ffmpeg',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== 'ffmpeg' && !existsSync(candidate)) continue;
    const check = spawnSync(candidate, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
    if (check.status === 0 && /\blibx264\b/.test(`${check.stdout}\n${check.stderr}`)) return candidate;
  }
  throw new Error('找不到支持 libx264 的 FFmpeg');
}

export function findFfprobe(ffmpeg) {
  const beside = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  if (existsSync(beside)) return beside;
  const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) return 'ffprobe';
  throw new Error('找不到 ffprobe');
}

export async function transcodeAndProbe(webmPath, mp4Path, expected) {
  const ffmpeg = findFfmpeg();
  const converted = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'warning', '-i', webmPath,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-r', '30', '-an', mp4Path,
  ], { encoding: 'utf8', windowsHide: true });
  if (converted.status !== 0) throw new Error(`FFmpeg 转码失败：${converted.stderr}`);
  const ffprobe = findFfprobe(ffmpeg);
  const probed = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate',
    '-of', 'json', mp4Path,
  ], { encoding: 'utf8', windowsHide: true });
  if (probed.status !== 0) throw new Error(`ffprobe 验证失败：${probed.stderr}`);
  const info = JSON.parse(probed.stdout);
  const duration = Number(info.format?.duration ?? 0);
  const video = info.streams?.find((stream) => stream.codec_name);
  if (!video || video.codec_name !== 'h264') throw new Error(`MP4 编码不是 H.264：${video?.codec_name ?? 'none'}`);
  if (video.width !== videoSize.width || video.height !== videoSize.height) {
    throw new Error(`视频尺寸异常：${video.width}x${video.height}`);
  }
  if (duration < expected.min || duration > expected.max) {
    throw new Error(`视频时长 ${duration.toFixed(2)} 秒，不在 ${expected.min}-${expected.max} 秒范围内`);
  }
  return { duration, codec: video.codec_name, width: video.width, height: video.height, frameRate: video.r_frame_rate, size: Number(info.format?.size ?? 0), ffmpeg };
}

export function attachTelemetry(page) {
  const telemetry = { consoleErrors: [], pageErrors: [], httpErrors: [], requestFailures: [] };
  page.on('console', (message) => { if (message.type() === 'error') telemetry.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => telemetry.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) telemetry.httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText || 'unknown';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) telemetry.requestFailures.push(`${request.method()} ${request.url()} :: ${reason}`);
  });
  return telemetry;
}

export function assertCleanTelemetry(telemetry) {
  const critical = [...telemetry.pageErrors, ...telemetry.httpErrors, ...telemetry.requestFailures];
  if (critical.length) throw new Error(`录像过程中出现关键页面或接口错误：${critical.slice(0, 8).join(' | ')}`);
}

export async function recordFlow({ kind, rehearsal, targetSeconds, accepted, flow }) {
  await ensureOutputDirs();
  const names = kind === 'full'
    ? { webm: 'ruanjianbei-full-demo.webm', mp4: 'ruanjianbei-full-demo.mp4' }
    : { webm: 'ruanjianbei-highlight-60s.webm', mp4: 'ruanjianbei-highlight-60s.mp4' };
  const webmPath = path.join(outputDir, names.webm);
  const mp4Path = path.join(outputDir, names.mp4);
  const browser = await chromium.launch({ headless: true, args: ['--disable-infobars', '--disable-notifications'] });
  let context;
  let page;
  let video;
  const startedAt = Date.now();
  let telemetry;
  let markers = [];
  try {
    context = await browser.newContext({
      viewport: videoSize,
      deviceScaleFactor: 1,
      recordVideo: rehearsal ? undefined : { dir: rawDir, size: videoSize },
      permissions: [],
    });
    page = await context.newPage();
    page.setDefaultTimeout(45_000);
    video = page.video();
    telemetry = attachTelemetry(page);
    markers = await flow({ page, context, startedAt, rehearsal, targetSeconds });
    if (!rehearsal) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed > accepted.max - 0.8) throw new Error(`流程耗时 ${elapsed.toFixed(1)} 秒，超过正式录像上限`);
      const human = createHumanDriver(page);
      await holdUntil(page, human, startedAt, targetSeconds);
    }
    assertCleanTelemetry(telemetry);
    await page.close();
    await context.close();
    context = undefined;
    let media = null;
    if (!rehearsal && video) {
      await video.saveAs(webmPath);
      media = await transcodeAndProbe(webmPath, mp4Path, accepted);
      media.webmBytes = (await stat(webmPath)).size;
      media.mp4Bytes = (await stat(mp4Path)).size;
    }
    const report = { status: 'PASS', kind, rehearsal, generatedAt: new Date().toISOString(), markers, telemetry, media, webmPath: rehearsal ? null : webmPath, mp4Path: rehearsal ? null : mp4Path };
    await writeFile(path.join(reportDir, `${kind}-${rehearsal ? 'rehearsal' : 'recording'}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(rehearsal ? `${kind.toUpperCase()}_REHEARSAL_PASS` : JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    const report = { status: 'FAIL', kind, rehearsal, generatedAt: new Date().toISOString(), markers, telemetry, error: error?.stack || String(error) };
    await writeFile(path.join(reportDir, `${kind}-${rehearsal ? 'rehearsal' : 'recording'}-failed.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
