/**
 * Page 2 — screen region calibration.
 *
 * Runs the analysis over sampled frames, overlays the detector's score
 * heatmap and detected quads, and supports manual add/edit/drag of
 * four-point polygons. A tracking preview scrubs through the clip so
 * pan-following can be verified before processing.
 */

import { el, navigate } from './router';
import { store } from '../state/store';
import { getSource } from './mediaPage';
import { ProcessingEngine } from '../engine/ProcessingEngine';
import { detectScreens, DEFAULT_DETECTION_OPTIONS } from '../analysis/screenDetector';
import type { Quad } from '../types';

let engine: ProcessingEngine | null = null;

export function getEngine(): ProcessingEngine | null {
  return engine;
}

export function disposeEngine(): void {
  engine?.dispose();
  engine = null;
}

/** Debug hook for E2E diagnostics. */
export function getEngineDebug(): ProcessingEngine | null {
  return engine;
}

export function renderCalibrationPage(): HTMLElement {
  const page = el('div', { class: 'page calibration-page' });
  const source0 = getSource();
  if (!source0) {
    page.innerHTML = '<p class="hint">请先在素材页导入视频或生成测试片。</p>';
    return page;
  }
  const source = source0;
  page.innerHTML = `
    <section class="card">
      <h2>LED 屏区域标定</h2>
      <div class="row wrap">
        <button id="btn-auto" class="primary">自动检测屏幕</button>
        <button id="btn-manual">手动添加区域</button>
        <button id="btn-clear">清空区域</button>
        <label class="inline"><input type="checkbox" id="chk-heat" checked> 显示检测热力图</label>
        <span id="cal-status" class="hint"></span>
      </div>
      <div class="stage-wrap">
        <canvas id="cal-canvas"></canvas>
      </div>
      <div class="row">
        <label>跟踪预览帧 <input type="range" id="scrub" min="0" max="${source.frameCount - 1}" value="0"></label>
        <span id="scrub-label">0 / ${source.frameCount - 1}</span>
        <button id="btn-play">播放</button>
      </div>
      <ol class="hint" id="region-list"></ol>
    </section>
    <section class="card">
      <h3>操作说明</h3>
      <ul class="hint">
        <li>自动检测依据亮度时序起伏与频谱一致性打分，连通域拟合为最大面积四边形。</li>
        <li>拖拽四角调整多边形；拖边可整体平移；双击区域可删除。</li>
        <li>下方滑块回放跟踪结果，镜头平移时多边形应贴住 LED 屏移动。</li>
      </ul>
      <button id="btn-next" class="primary">进入处理预览 →</button>
    </section>
  `;

  const canvas = page.querySelector<HTMLCanvasElement>('#cal-canvas')!;
  const maxW = 1080;
  const scale = Math.min(1, maxW / source.width);
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext('2d')!;
  const status = page.querySelector<HTMLElement>('#cal-status')!;
  let heatmap: Float32Array | null = null;
  let showHeat = true;
  let manualPolys: Quad[] = [];
  let playTimer: number | null = null;

  async function ensureEngine(): Promise<ProcessingEngine> {
    if (!engine || engine.source !== source) {
      engine = new ProcessingEngine(source);
    }
    return engine;
  }

  async function drawFrame(index: number): Promise<void> {
    const eng = await ensureEngine();
    const image = await source.frameImage(index) as CanvasImageSource;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (showHeat && heatmap) {
      const cols = eng.pipeline.cols;
      const rows = eng.pipeline.rows;
      const cw = canvas.width / cols;
      const ch = canvas.height / rows;
      for (let c = 0; c < cols * rows; c++) {
        const v = heatmap[c]!;
        if (v < 0.05) continue;
        const gx = (c % cols) * cw;
        const gy = ((c / cols) | 0) * ch;
        ctx.fillStyle = `rgba(255,80,40,${(v * 0.45).toFixed(3)})`;
        ctx.fillRect(gx, gy, Math.ceil(cw), Math.ceil(ch));
      }
    }
    const analysis = eng.pipeline.getFrameAnalysis(index);
    const polys = analysis?.polygons ?? [];
    const all = polys.length
      ? polys.map((p) => p.points)
      : manualPolys.map((q) => q.points.map(([x, y]) => [x * source.width, y * source.height] as [number, number]));
    all.forEach((pts, ri) => {
      ctx.beginPath();
      pts.forEach(([x, y], k) => {
        const sx = x * scale;
        const sy = y * scale;
        if (k === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.strokeStyle = '#36e2a0';
      ctx.lineWidth = 2;
      ctx.stroke();
      pts.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x * scale, y * scale, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd23f';
        ctx.fill();
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      ctx.fillStyle = '#36e2a0';
      ctx.font = '13px sans-serif';
      ctx.fillText(`区域 ${ri + 1}`, pts[0]![0] * scale, pts[0]![1] * scale - 8);
    });
    updateRegionList(all.length);
  }

  function updateRegionList(n: number): void {
    const list = page.querySelector<HTMLElement>('#region-list')!;
    list.innerHTML = n
      ? Array.from({ length: n }, (_, i) => `<li>区域 ${i + 1}：${store.get().regions[i]?.beat ? `拍频 ${store.get().regions[i]!.beat!.frequencyHz.toFixed(2)} Hz，置信度 ${store.get().regions[i]!.beat!.confidence.toFixed(2)}` : '拍频待估计'}</li>`).join('')
      : '<li>尚无标定区域</li>';
  }

  page.querySelector<HTMLInputElement>('#chk-heat')!.addEventListener('change', (e) => {
    showHeat = (e.target as HTMLInputElement).checked;
    drawFrame(Number(page.querySelector<HTMLInputElement>('#scrub')!.value));
  });

  page.querySelector<HTMLButtonElement>('#btn-auto')!.addEventListener('click', async () => {
    status.textContent = '正在缓冲帧并检测…';
    const eng = await ensureEngine();
    // Ingest contiguous frames: the temporal statistics need the true frame
    // cadence (sparse indices would alias the beat frequency). Cap the
    // detection window at 150 frames for responsiveness.
    const detectWindow = Math.min(source.frameCount, 150);
    for (let i = 0; i < detectWindow; i++) {
      await eng.ingestFrame(i);
      if (i % 24 === 0) status.textContent = `缓冲帧 ${i + 1}/${detectWindow}…`;
    }
    const det = detectScreens(eng.pipeline.grid, {
      ...DEFAULT_DETECTION_OPTIONS,
      fs: source.fps,
    });
    heatmap = det.scoreGrid;
    manualPolys = det.regions.map((r) => r.basePolygon);
    eng.pipeline.setManualRegions(manualPolys.map((q) => q.points.flat()));
    // Continue tracking across the rest of the clip for the scrub preview.
    for (let i = detectWindow; i < source.frameCount; i++) {
      await eng.ingestFrame(i);
    }
    store.update({
      regions: eng.pipeline.regions.map((r) => ({ ...r })),
      detectionScoreGrid: det.scoreGrid,
    });
    status.textContent = `检测到 ${det.regions.length} 个屏幕区域`;
    store.logLine(`自动检测完成：${det.regions.length} 个区域`);
    drawFrame(0);
  });

  page.querySelector<HTMLButtonElement>('#btn-manual')!.addEventListener('click', async () => {
    const w = source.width;
    const h = source.height;
    const quad: Quad = {
      points: [
        [0.2, 0.55],
        [0.8, 0.55],
        [0.8, 0.8],
        [0.2, 0.8],
      ],
    };
    manualPolys.push(quad);
    const eng = await ensureEngine();
    eng.pipeline.setManualRegions(manualPolys.map((q) => q.points.flat()));
    store.update({ regions: eng.pipeline.regions.map((r) => ({ ...r })) });
    drawFrame(Number(page.querySelector<HTMLInputElement>('#scrub')!.value));
    void w;
    void h;
  });

  page.querySelector<HTMLButtonElement>('#btn-clear')!.addEventListener('click', () => {
    manualPolys = [];
    heatmap = null;
    engine?.pipeline.setManualRegions([]);
    store.update({ regions: [] });
    drawFrame(Number(page.querySelector<HTMLInputElement>('#scrub')!.value));
  });

  // Vertex / edge dragging.
  let drag: { poly: number; vertex: number; edge: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * source.width;
    const my = ((e.clientY - rect.top) / rect.height) * source.height;
    for (let pi = manualPolys.length - 1; pi >= 0; pi--) {
      const pts = manualPolys[pi]!.points;
      for (let vi = 0; vi < pts.length; vi++) {
        const [px, py] = pts[vi]!;
        if (Math.hypot(px * source.width - mx, py * source.height - my) < 18 / scale) {
          drag = { poly: pi, vertex: vi, edge: false };
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
      // Inside polygon -> whole-polygon translate.
      let inside = false;
      const flat = pts.flatMap(([x, y]) => [x * source.width, y * source.height]);
      let hit = false;
      for (let i = 0, j = flat.length / 2 - 1; i < flat.length / 2; j = i++) {
        const xi = flat[i * 2]!;
        const yi = flat[i * 2 + 1]!;
        const xj = flat[j * 2]!;
        const yj = flat[j * 2 + 1]!;
        if (yi > my !== yj > my && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) hit = !hit;
      }
      inside = hit;
      if (inside) {
        drag = { poly: pi, vertex: -1, edge: true };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const pts = manualPolys[drag.poly]!.points;
    if (drag.vertex >= 0) {
      pts[drag.vertex] = [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
    } else {
      const dx = nx - (pts[0]![0] + (pts[1]![0] - pts[0]![0]) * 0.5);
      const dy = ny - (pts[0]![1] + (pts[2]![1] - pts[0]![1]) * 0.5);
      for (let k = 0; k < pts.length; k++) {
        pts[k] = [
          Math.min(1, Math.max(0, pts[k]![0] + dx)),
          Math.min(1, Math.max(0, pts[k]![1] + dy)),
        ];
      }
    }
    drawFrame(Number(page.querySelector<HTMLInputElement>('#scrub')!.value));
  });
  canvas.addEventListener('pointerup', async () => {
    if (drag) {
      engine?.pipeline.setManualRegions(manualPolys.map((q) => q.points.flat()));
      store.update({ regions: engine ? engine.pipeline.regions.map((r) => ({ ...r })) : [] });
      drag = null;
    }
  });
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * source.width;
    const my = ((e.clientY - rect.top) / rect.height) * source.height;
    manualPolys = manualPolys.filter((q) => {
      const flat = q.points.flatMap(([x, y]) => [x * source.width, y * source.height]);
      let hit = false;
      for (let i = 0, j = flat.length / 2 - 1; i < flat.length / 2; j = i++) {
        const xi = flat[i * 2]!;
        const yi = flat[i * 2 + 1]!;
        const xj = flat[j * 2]!;
        const yj = flat[j * 2 + 1]!;
        if (yi > my !== yj > my && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return !hit;
    });
    engine?.pipeline.setManualRegions(manualPolys.map((q) => q.points.flat()));
    drawFrame(Number(page.querySelector<HTMLInputElement>('#scrub')!.value));
  });

  const scrub = page.querySelector<HTMLInputElement>('#scrub')!;
  const scrubLabel = page.querySelector<HTMLElement>('#scrub-label')!;
  scrub.addEventListener('input', () => {
    const i = Number(scrub.value);
    scrubLabel.textContent = `${i} / ${source.frameCount - 1}`;
    drawFrame(i);
  });

  page.querySelector<HTMLButtonElement>('#btn-play')!.addEventListener('click', (e) => {
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
      scrubLabel.textContent = `${i} / ${source.frameCount - 1}`;
      drawFrame(i);
    }, 1000 / source.fps);
  });

  page.querySelector<HTMLButtonElement>('#btn-next')!.addEventListener('click', () => navigate('preview'));
  drawFrame(0);
  return page;
}
