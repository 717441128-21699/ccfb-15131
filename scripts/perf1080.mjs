/**
 * 1080p per-frame performance check.
 * Measures the GPU composite path (the shader graph that must fit the 20 ms
 * budget) at full 1920x1080, excluding video decode/seek and analysis.
 *
 * Run: node scripts/perf1080.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { port: 5248, strictPort: false } });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://localhost:5248/';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.selectOption('#res-select', '1920x1080');
  await page.fill('#frame-count', '96');
  await page.fill('#flicker-amp', '0.5');
  await page.fill('#pan-speed', '0');
  await page.uncheck('#with-player');
  await page.click('.matrix-cell:nth-child(4)');
  await page.waitForSelector('.calibration-page');
  await page.click('#btn-auto');
  await page.waitForFunction(
    () => document.querySelector('#cal-status')?.textContent?.includes('检测到'),
    { timeout: 120000 },
  );
  await page.click('#btn-next');
  await page.waitForSelector('.preview-page');

  const perf = await page.evaluate(async () => {
    const eng = window.__app?.getEngine();
    // Ingest enough frames to establish the beat, then time render-only calls.
    for (let i = 0; i < 50; i++) await eng.ingestFrame(i);
    const samples = [];
    const endToEnd = [];
    for (let i = 0; i < 40; i++) {
      await eng.ingestFrame(i);
      const t0 = performance.now();
      eng.renderProcessed(i, false);
      // Force GPU completion so the timing reflects real work, not just queuing.
      eng.renderer.gl.finish();
      samples.push(performance.now() - t0);
    }
    // End-to-end: full ingest (downsample readback + CPU analysis) + render.
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await eng.ingestFrame(i);
      eng.renderProcessed(i, false);
      eng.renderer.gl.finish();
      endToEnd.push(performance.now() - t0);
    }
    const stats = (a) => {
      const s = a.slice().sort((x, y) => x - y);
      const mean = s.reduce((x, y) => x + y, 0) / s.length;
      return {
        meanMs: Number(mean.toFixed(3)),
        p95Ms: Number(s[Math.floor(s.length * 0.95)].toFixed(3)),
        maxMs: Number(s[s.length - 1].toFixed(3)),
      };
    };
    return {
      resolution: `${eng.source.width}x${eng.source.height}`,
      gpuComposite: stats(samples),
      fullFrameIngestPlusRender: stats(endToEnd),
      budgetMs: 20,
      passes: stats(endToEnd).p95Ms <= 20,
      note: 'swiftshader software GL; real GPUs are substantially faster',
    };
  });
  console.log('1080p GPU path timing:', JSON.stringify(perf, null, 2));
  if (!perf.passes) process.exitCode = 1;
  if (errors.length) {
    console.error('browser errors:', errors);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await server.close();
}
