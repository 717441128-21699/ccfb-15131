/**
 * Page 1 — media import.
 * Real video files plus the 24-combination synthetic test matrix
 * (shutter angle x LED refresh rate).
 */

import { el, navigate } from './router';
import { store } from '../state/store';
import { VideoFileSource, SyntheticSource } from '../media/frameSource';
import {
  FULL_MATRIX,
  TestClipGenerator,
  DEFAULT_CLIP_CONFIG,
  type TestClipConfig,
} from '../synthetic/testClipGenerator';
import type { FrameSource } from '../media/frameSource';

let currentSource: FrameSource | null = null;

export function getSource(): FrameSource | null {
  return currentSource;
}

export function setSource(src: FrameSource): void {
  currentSource = src;
}

export function renderMediaPage(): HTMLElement {
  const page = el('div', { class: 'page media-page' });
  page.innerHTML = `
    <section class="card">
      <h2>导入素材</h2>
      <p class="hint">支持浏览器可解码的视频文件（MP4/WebM/MOV）。按 30fps 假设逐帧寻址；合成测试片按精确帧率生成。</p>
      <div class="row">
        <label class="file-btn">
          选择视频文件
          <input type="file" id="file-input" accept="video/*" hidden>
        </label>
        <span id="file-status" class="hint"></span>
      </div>
    </section>
    <section class="card">
      <h2>合成测试片矩阵（快门 × 刷新率，共 24 组）</h2>
      <p class="hint">每组都内置已知 LED 拍频、滚动条纹、镜头平移与横穿屏幕的球员，并提供真值遮罩用于质量评估。</p>
      <div class="clip-controls">
        <label>分辨率
          <select id="res-select">
            <option value="1920x1080" selected>1920×1080</option>
            <option value="1280x720">1280×720</option>
          </select>
        </label>
        <label>帧数 <input type="number" id="frame-count" value="180" min="64" max="600" step="16"></label>
        <label>闪烁幅度 <input type="number" id="flicker-amp" value="0.35" min="0.05" max="0.8" step="0.05"></label>
        <label>条纹周期(屏高) <input type="number" id="stripe-cycles" value="1.5" min="0.25" max="4" step="0.25"></label>
        <label>镜头平移(px/帧) <input type="number" id="pan-speed" value="1.2" min="0" max="6" step="0.2"></label>
        <label class="inline" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="with-player" checked style="width:auto"> 含横穿球员</label>
      </div>
      <div class="matrix" id="matrix"></div>
    </section>
  `;

  const fileInput = page.querySelector<HTMLInputElement>('#file-input')!;
  const fileStatus = page.querySelector<HTMLElement>('#file-status')!;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileStatus.textContent = '正在读取元数据…';
    try {
      const src = await VideoFileSource.create(file);
      currentSource = src;
      store.update({
        clip: {
          name: file.name,
          width: src.width,
          height: src.height,
          fps: src.fps,
          frameCount: src.frameCount,
          durationSec: src.durationSec,
          isSynthetic: false,
        },
        regions: [],
        metrics: null,
        gpuMsSamples: [],
      });
      store.logLine(`已导入视频 ${file.name}（${src.width}×${src.height}）`);
      fileStatus.textContent = `已加载：${file.name}`;
      navigate('calibration');
    } catch (err) {
      fileStatus.textContent = `加载失败：${(err as Error).message}`;
    }
  });

  const matrix = page.querySelector<HTMLElement>('#matrix')!;
  for (const combo of FULL_MATRIX) {
    const btn = el('button', { class: 'matrix-cell' });
    btn.innerHTML = `<b>${combo.shutter.label}</b><span>${combo.refresh.label}</span>`;
    btn.addEventListener('click', () => {
      const res = page.querySelector<HTMLSelectElement>('#res-select')!.value.split('x');
      const cfg: TestClipConfig = {
        ...DEFAULT_CLIP_CONFIG,
        width: Number(res![0]),
        height: Number(res![1]),
        frameCount: Number(page.querySelector<HTMLInputElement>('#frame-count')!.value),
        flickerAmplitude: Number(page.querySelector<HTMLInputElement>('#flicker-amp')!.value),
        stripeCycles: Number(page.querySelector<HTMLInputElement>('#stripe-cycles')!.value),
        panPxPerFrame: Number(page.querySelector<HTMLInputElement>('#pan-speed')!.value),
        withPlayer: page.querySelector<HTMLInputElement>('#with-player')!.checked,
        shutter: combo.shutter,
        refresh: combo.refresh,
      };
      const gen = new TestClipGenerator(cfg);
      const src = new SyntheticSource(gen);
      currentSource = src;
      store.update({
        clip: {
          name: `合成片 ${combo.shutter.label} / ${combo.refresh.label}`,
          width: src.width,
          height: src.height,
          fps: src.fps,
          frameCount: src.frameCount,
          durationSec: src.durationSec,
          isSynthetic: true,
          syntheticId: combo.id,
        },
        regions: [],
        metrics: null,
        gpuMsSamples: [],
      });
      store.logLine(`生成合成片：${combo.id}（快门 ${combo.shutter.shutterAngleDeg}°，刷新 ${combo.refresh.refreshHz}Hz）`);
      navigate('calibration');
    });
    matrix.appendChild(btn);
  }
  return page;
}
