/**
 * Page 3 — processing preview.
 *
 * Renders original vs. compensated frames through the WebGL2 graph,
 * exposes the compensation parameters, measures per-frame GPU time
 * against the 20 ms budget, and runs the full QA suite (outside-pixel
 * budget, text contrast, flicker attenuation, occlusion leak).
 */

import { el, navigate } from './router';
import { store } from '../state/store';
import { getSource } from './mediaPage';
import { getEngine } from './calibrationPage';
import {
  outsideChangedFraction,
  textContrastRatio,
  flickerAttenuationDbPixelwise,
  occlusionLeak,
  summarizeQa,
  type RgbaFrame,
} from '../qa/metrics';
import { ProcessingEngine } from '../engine/ProcessingEngine';

export function renderPreviewPage(): HTMLElement {
  const page = el('div', { class: 'page preview-page' });
  const source0 = getSource();
  if (!source0) {
    page.innerHTML = '<p class="hint">请先导入素材。</p>';
    return page;
  }
  const source = source0;
  page.innerHTML = `
    <section class="card">
      <h2>处理预览与质量评估</h2>
      <div class="row wrap">
        <label>补偿强度 <input type="range" id="strength" min="0" max="1" step="0.05" value="1"></label>
        <label>遮罩羽化(px) <input type="range" id="feather" min="0.5" max="8" step="0.5" value="2.5"></label>
        <label>对比度保护半径 <input type="range" id="guard-r" min="1" max="6" step="1" value="3"></label>
        <button id="btn-analyze" class="primary">全片分析</button>
        <button id="btn-qa">运行质量评估</button>
        <span id="pv-status" class="hint"></span>
      </div>
      <div class="stage-wrap ab-wrap">
        <canvas id="pv-canvas"></canvas>
        <div class="ab-divider" id="ab-divider"><span>原图 | 修复</span></div>
        <input type="range" id="ab-slider" min="0" max="100" value="50" class="ab-slider">
      </div>
      <div class="row">
        <label>帧 <input type="range" id="pv-scrub" min="0" max="${source.frameCount - 1}" value="0"></label>
        <span id="pv-frame-label">帧 0</span>
        <button id="pv-play">播放</button>
        <label class="inline"><input type="checkbox" id="pv-mask"> 显示屏幕遮罩</label>
      </div>
    </section>
    <section class="card">
      <h3>实时指标</h3>
      <div class="metrics-grid" id="metrics-grid">
        <div><b>GPU 耗时</b><span id="m-gpu">—</span></div>
        <div><b>屏外改动像素</b><span id="m-outside">—</span></div>
        <div><b>文字对比度比</b><span id="m-contrast">—</span></div>
        <div><b>闪烁衰减</b><span id="m-flicker">—</span></div>
        <div><b>遮挡泄漏</b><span id="m-leak">—</span></div>
        <div><b>20ms 预算</b><span id="m-budget">—</span></div>
      </div>
      <div id="qa-log" class="qa-log"></div>
      <button id="btn-next" class="primary">进入导出 →</button>
    </section>
  `;

  const canvas = page.querySelector<HTMLCanvasElement>('#pv-canvas')!;
  const displayScale = Math.min(1, 1080 / source.width);
  canvas.width = Math.round(source.width * displayScale);
  canvas.height = Math.round(source.height * displayScale);
  const ctx = canvas.getContext('2d')!;
  const status = page.querySelector<HTMLElement>('#pv-status')!;
  let engine: ProcessingEngine | null = getEngine();
  let showMask = false;
  let playTimer: number | null = null;
  const gpuSamples: number[] = [];

  function requireEngine(): ProcessingEngine {
    if (!engine) engine = new ProcessingEngine(source);
    return engine;
  }

  async function showFrame(index: number): Promise<void> {
    const eng = requireEngine();
    await eng.ingestFrame(index);
    const ms = eng.renderProcessed(index, false);
    if (ms > 0) gpuSamples.push(ms);
    const image = (await source.frameImage(index)) as CanvasImageSource;
    const ab = Number(page.querySelector<HTMLInputElement>('#ab-slider')!.value) / 100;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const splitX = Math.round(canvas.width * ab);
    // Right side: processed output (GL canvas is at full resolution).
    const glCanvas = eng.renderer.gl.canvas as HTMLCanvasElement;
    ctx.drawImage(
      glCanvas,
      Math.round(glCanvas.width * ab), 0, glCanvas.width - Math.round(glCanvas.width * ab), glCanvas.height,
      splitX, 0, canvas.width - splitX, canvas.height,
    );
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, canvas.height);
    ctx.stroke();
    if (showMask) {
      const analysis = eng.pipeline.getFrameAnalysis(index);
      if (analysis) {
        ctx.strokeStyle = '#36e2a0';
        ctx.lineWidth = 2;
        for (const poly of analysis.polygons) {
          ctx.beginPath();
          poly.points.forEach(([x, y], k) => {
            const sx = x * displayScale;
            const sy = y * displayScale;
            if (k === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          });
          ctx.closePath();
          ctx.stroke();
        }
      }
    }
    page.querySelector<HTMLElement>('#m-gpu')!.textContent = ms > 0 ? `${ms.toFixed(2)} ms` : '等待分析';
    page.querySelector<HTMLElement>('#m-budget')!.textContent = ms > 0
      ? (ms <= 20 ? '✔ 达标' : `✘ 超预算 ${(ms - 20).toFixed(1)}ms`)
      : '—';
    page.querySelector<HTMLElement>('#pv-frame-label')!.textContent = `帧 ${index}`;
  }

  page.querySelector<HTMLInputElement>('#strength')!.addEventListener('input', (e) => {
    const eng = requireEngine();
    eng.renderer.settings.compensationStrength = Number((e.target as HTMLInputElement).value);
    store.patchSettings({ compensationStrength: Number((e.target as HTMLInputElement).value) });
    showFrame(Number(page.querySelector<HTMLInputElement>('#pv-scrub')!.value));
  });
  page.querySelector<HTMLInputElement>('#feather')!.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    requireEngine().renderer.settings.featherPx = v;
    store.patchSettings({ featherPx: v });
    showFrame(Number(page.querySelector<HTMLInputElement>('#pv-scrub')!.value));
  });
  page.querySelector<HTMLInputElement>('#guard-r')!.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    requireEngine().renderer.settings.contrastGuardRadius = v;
    store.patchSettings({ contrastGuardRadius: v });
    showFrame(Number(page.querySelector<HTMLInputElement>('#pv-scrub')!.value));
  });
  page.querySelector<HTMLInputElement>('#pv-mask')!.addEventListener('change', (e) => {
    showMask = (e.target as HTMLInputElement).checked;
    showFrame(Number(page.querySelector<HTMLInputElement>('#pv-scrub')!.value));
  });
  page.querySelector<HTMLInputElement>('#ab-slider')!.addEventListener('input', () => {
    showFrame(Number(page.querySelector<HTMLInputElement>('#pv-scrub')!.value));
  });

  const scrub = page.querySelector<HTMLInputElement>('#pv-scrub')!;
  scrub.addEventListener('input', () => showFrame(Number(scrub.value)));
  page.querySelector<HTMLButtonElement>('#pv-play')!.addEventListener('click', (e) => {
    const btn = e.target as HTMLButtonElement;
    if (playTimer !== null) {
      clearInterval(playTimer);
      playTimer = null;
      btn.textContent = '播放';
      return;
    }
    btn.textContent = '暂停';
    playTimer = window.setInterval(() => {
      let i = Number(scrub.value) + 1;
      if (i >= source.frameCount) i = 0;
      scrub.value = String(i);
      showFrame(i);
    }, 1000 / source.fps);
  });

  page.querySelector<HTMLButtonElement>('#btn-analyze')!.addEventListener('click', async () => {
    const eng = requireEngine();
    status.textContent = '全片分析中…';
    await eng.analyzeAll((f) => {
      status.textContent = `分析进度 ${(f * 100).toFixed(0)}%`;
    });
    status.textContent = '分析完成';
    store.logLine(`全片分析完成，跟踪 ${eng.pipeline.regions.length} 个区域`);
    showFrame(0);
  });

  page.querySelector<HTMLButtonElement>('#btn-qa')!.addEventListener('click', async () => {
    const eng = requireEngine();
    status.textContent = '质量评估中…';
    if (eng.pipeline.regions.length === 0) await eng.analyzeAll();
    const { width, height } = source;
    const screenMask = new Uint8Array(width * height);
    const occlusionMasks: Uint8Array[] = [];
    const origFrames: RgbaFrame[] = [];
    const procFrames: RgbaFrame[] = [];
    let outsideSum = 0;
    let contrastSum = 0;
    let leakSum = 0;
    const measured: number[] = [];
    // Sample EVERY frame: the flicker beat can be as high as ~15 Hz at 30 fps,
    // so sub-sampling would alias it and corrupt the temporal variance metric.
    // For long clips cap at 64 contiguous frames (~2 s at 30 fps) to bound cost.
    const qaFrameCount = Math.min(source.frameCount, 64);
    let used = 0;
    for (let i = 0; i < qaFrameCount; i++) {
      await eng.ingestFrame(i);
      const ms = eng.renderProcessed(i, false);
      measured.push(ms);
      const image = await source.frameImage(i);
      const tmp = document.createElement('canvas');
      tmp.width = width;
      tmp.height = height;
      tmp.getContext('2d')!.drawImage(image as CanvasImageSource, 0, 0);
      const origData = tmp.getContext('2d')!.getImageData(0, 0, width, height);
      const procData = eng.renderer.readOutput();
      // Per-frame occlusion; screen mask accumulates across frames (union).
      const analysis = eng.pipeline.getFrameAnalysis(i)!;
      const frameOcclusion = new Uint8Array(width * height);
      fillMasks(screenMask, frameOcclusion, analysis, width, height, eng);
      // For synthetic clips, use the generator's ground-truth player mask so
      // QA judges compensation on genuinely visible board pixels only (the
      // runtime shader still consumes the *detected* occlusion grid).
      const synth = (source as unknown as { generator?: { playerMaskAt: (i: number) => Uint8Array } }).generator;
      if (synth && typeof synth.playerMaskAt === 'function') {
        const truth = synth.playerMaskAt(i);
        for (let p = 0; p < frameOcclusion.length; p++) if (truth[p]) frameOcclusion[p] = 1;
      }
      occlusionMasks.push(frameOcclusion);
      const orig: RgbaFrame = { width, height, data: new Uint8ClampedArray(origData.data) };
      const proc: RgbaFrame = { width, height, data: new Uint8ClampedArray(procData) };
      outsideSum += outsideChangedFraction(orig, proc, screenMask);
      contrastSum += textContrastRatio(orig, proc, screenMask, eng.renderer.settings.contrastGuardRadius);
      leakSum += occlusionLeak(orig, proc, frameOcclusion);
      origFrames.push(orig);
      procFrames.push(proc);
      used++;
      status.textContent = `质量评估 ${((i / qaFrameCount) * 100).toFixed(0)}%`;
    }
    const report = summarizeQa({
      outsideChangedFraction: outsideSum / used,
      textContrastRatio: contrastSum / used,
      flickerAttenuationDb: flickerAttenuationDbPixelwise(origFrames, procFrames, screenMask, 1.0, occlusionMasks),
      occlusionLeak: leakSum / used,
      gpuMsSamples: measured.length ? measured : gpuSamples,
    });
    store.update({
      metrics: {
        flickerAttenuationDb: report.flickerAttenuationDb,
        textContrastRatio: report.textContrastRatio,
        outsideChangedFraction: report.outsideChangedFraction,
        occlusionLeak: report.occlusionLeak,
      },
      gpuMsSamples: measured,
    });
    page.querySelector<HTMLElement>('#m-outside')!.textContent =
      `${(report.outsideChangedFraction * 100).toFixed(3)}% ${report.meetsOutsideBudget ? '✔' : '✘ (>0.5%)'}`;
    page.querySelector<HTMLElement>('#m-contrast')!.textContent =
      `${report.textContrastRatio.toFixed(3)} ${report.meetsContrast ? '✔' : '✘ (<1)'}`;
    page.querySelector<HTMLElement>('#m-flicker')!.textContent = `${report.flickerAttenuationDb.toFixed(1)} dB`;
    page.querySelector<HTMLElement>('#m-leak')!.textContent = report.occlusionLeak.toFixed(2);
    page.querySelector<HTMLElement>('#m-gpu')!.textContent =
      `均值 ${report.meanGpuMs.toFixed(2)} ms / P95 ${report.p95GpuMs.toFixed(2)} ms`;
    page.querySelector<HTMLElement>('#m-budget')!.textContent =
      report.meetsFrameBudget ? '✔ 达标 (P95 ≤ 20ms)' : '✘ 超预算';
    page.querySelector<HTMLElement>('#qa-log')!.innerHTML = `
      <p class="${report.meetsOutsideBudget ? 'pass' : 'fail'}">屏外改动 ${report.meetsOutsideBudget ? '达标' : '不达标'}：阈值 0.5%，实测 ${(report.outsideChangedFraction * 100).toFixed(3)}%</p>
      <p class="${report.meetsContrast ? 'pass' : 'fail'}">广告字对比度 ${report.meetsContrast ? '达标' : '不达标'}：比值 ${report.textContrastRatio.toFixed(3)}（要求 ≥ 1.000）</p>
      <p class="pass">闪烁衰减：${report.flickerAttenuationDb.toFixed(1)} dB</p>
      <p class="pass">遮挡区域平均改动：${report.occlusionLeak.toFixed(2)} / 255</p>
      <p class="${report.meetsFrameBudget ? 'pass' : 'fail'}">1080p 帧预算：P95 ${report.p95GpuMs.toFixed(2)} ms（要求 ≤ 20 ms）</p>
    `;
    store.logLine(`QA：屏外 ${(report.outsideChangedFraction * 100).toFixed(3)}%，对比度 ${report.textContrastRatio.toFixed(3)}，P95 ${report.p95GpuMs.toFixed(2)}ms`);
    status.textContent = '质量评估完成';
  });

  page.querySelector<HTMLButtonElement>('#btn-next')!.addEventListener('click', () => navigate('export'));
  showFrame(0);
  return page;
}

function fillMasks(
  screenMask: Uint8Array,
  occlusionMask: Uint8Array,
  analysis: import('../types').FrameAnalysis,
  width: number,
  height: number,
  eng: ProcessingEngine,
): void {
  for (let r = 0; r < analysis.polygons.length; r++) {
    const poly = analysis.polygons[r]!.points;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const flat = poly.flatMap(([x, y]) => [x, y]);
    for (let y = Math.max(0, Math.floor(minY)); y < Math.min(height, Math.ceil(maxY)); y++) {
      for (let x = Math.max(0, Math.floor(minX)); x < Math.min(width, Math.ceil(maxX)); x++) {
        if (pointIn(x, y, flat)) screenMask[y * width + x] = 1;
      }
    }
  }
  // Occlusion grid -> full-res mask.
  const grid = eng.pipeline.occlusionGrid;
  const cols = eng.pipeline.cols;
  const rows = eng.pipeline.rows;
  for (let c = 0; c < grid.length; c++) {
    if (grid[c]! < 0.5) continue;
    const gx = c % cols;
    const gy = (c / cols) | 0;
    const x0 = Math.floor((gx / cols) * width);
    const x1 = Math.ceil(((gx + 1) / cols) * width);
    const y0 = Math.floor((gy / rows) * height);
    const y1 = Math.ceil(((gy + 1) / rows) * height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) occlusionMask[y * width + x] = 1;
    }
  }
}

function pointIn(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!;
    const yi = poly[i * 2 + 1]!;
    const xj = poly[j * 2]!;
    const yj = poly[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
