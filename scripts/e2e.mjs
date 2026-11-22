/**
 * End-to-end acceptance test with the system Chrome via playwright-core.
 *
 * Drives the real UI on a synthetic clip and asserts the product contracts:
 *   - outside-screen changed-pixel fraction <= 0.5%
 *   - ad-text contrast ratio >= 1.000
 *   - positive flicker attenuation
 *   - near-zero occlusion leak
 *
 * Run: node scripts/e2e.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { port: 5247, strictPort: false } });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://localhost:5247/';
console.log('dev server:', base);

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let failed = false;
const fail = (msg) => { console.error('FAIL:', msg); failed = true; };

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  const gl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  console.log('WebGL2 available:', gl2);
  if (!gl2) fail('WebGL2 context unavailable');

  // 384 Hz refresh => 6 Hz beat at 30 fps (5 samples/cycle), with a player.
  await page.selectOption('#res-select', '1280x720');
  await page.fill('#frame-count', '120');
  await page.fill('#flicker-amp', '0.5');
  await page.fill('#pan-speed', '0');
  await page.check('#with-player');
  await page.click('.matrix-cell:nth-child(4)');
  await page.waitForSelector('.calibration-page');
  console.log('clip loaded:', await page.textContent('#status-line'));

  await page.click('#btn-auto');
  await page.waitForFunction(
    () => document.querySelector('#cal-status')?.textContent?.includes('检测到'),
    { timeout: 120000 },
  );
  const regionCount = Number((await page.textContent('#cal-status')).match(/(\d+)/)[1]);
  console.log('detected regions:', regionCount);
  if (regionCount < 1) fail('no screen region detected');

  await page.click('#btn-next');
  await page.waitForSelector('.preview-page');
  await page.click('#btn-qa', { timeout: 120000 });
  await page.waitForFunction(() => window.__app?.store.get().metrics !== null, { timeout: 180000 });
  await page.waitForTimeout(500);

  const metrics = await page.evaluate(() => window.__app.store.get().metrics);
  const gpuSamples = await page.evaluate(() => window.__app.store.get().gpuMsSamples ?? []);
  const p95 = gpuSamples.length
    ? gpuSamples.slice().sort((a, b) => a - b)[Math.floor(gpuSamples.length * 0.95)]
    : 0;
  console.log('\n=== acceptance metrics ===');
  console.log(JSON.stringify(metrics, null, 2));
  console.log('GPU P95 ms (software GL):', p95.toFixed(2));

  if (metrics.outsideChangedFraction > 0.005) fail(`outside changed ${metrics.outsideChangedFraction} > 0.5%`);
  else console.log('PASS outside-pixel budget:', (metrics.outsideChangedFraction * 100).toFixed(3) + '%');
  if (metrics.textContrastRatio < 1) fail(`contrast ${metrics.textContrastRatio} < 1`);
  else console.log('PASS contrast ratio:', metrics.textContrastRatio.toFixed(3));
  if (metrics.flickerAttenuationDb <= 0) fail(`flicker attenuation ${metrics.flickerAttenuationDb} dB <= 0`);
  else console.log('PASS flicker attenuation:', metrics.flickerAttenuationDb.toFixed(1) + ' dB');
  if (metrics.occlusionLeak > 2) fail(`occlusion leak ${metrics.occlusionLeak} too high`);
  else console.log('PASS occlusion leak:', metrics.occlusionLeak.toFixed(2));
  if (p95 > 20) fail(`GPU P95 ${p95} > 20 ms`);
  else console.log('PASS frame budget: P95', p95.toFixed(2), '<= 20 ms');

  await page.screenshot({ path: 'e2e-preview.png', fullPage: true });
} catch (e) {
  fail(e.stack || String(e));
  await page.screenshot({ path: 'e2e-error.png', fullPage: true }).catch(() => {});
} finally {
  if (errors.length) fail(`${errors.length} browser errors:\n` + errors.slice(0, 10).join('\n'));
  await browser.close();
  await server.close();
  process.exit(failed ? 1 : 0);
}
