import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

async function sample(label) {
  const result = await page.evaluate(async () => {
    const values = [];
    let previous = performance.now();
    const started = previous;
    await new Promise((resolve) => {
      function tick(now) {
        values.push(now - previous);
        previous = now;
        if (now - started < 6000) requestAnimationFrame(tick); else resolve();
      }
      requestAnimationFrame(tick);
    });
    const sorted = values.slice(1).sort((a, b) => a - b);
    return {
      samples: sorted.length,
      averageFrameMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      p95FrameMs: sorted[Math.floor(sorted.length * .95)],
      framesOver34ms: sorted.filter((value) => value > 34).length,
    };
  });
  console.log(JSON.stringify({ label, ...result }));
}

await page.goto('about:blank');
await sample('blank');
await page.goto('http://127.0.0.1:5174/login', { waitUntil: 'networkidle' });
await sample('login-idle');
await browser.close();
