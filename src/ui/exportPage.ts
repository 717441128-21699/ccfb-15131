/**
 * Page 4 — export. Renders the full processed clip through the GPU graph,
 * encodes with WebCodecs/mp4-muxer (MediaRecorder fallback), and shows
 * the final QA summary alongside the download.
 */

import { el, navigate } from './router';
import { store } from '../state/store';
import { getSource } from './mediaPage';
import { getEngine } from './calibrationPage';
import {
  exportProcessedMp4,
  downloadBlob,
  webCodecsSupported,
  DEFAULT_EXPORT_OPTIONS,
} from '../engine/exporter';
import { ProcessingEngine } from '../engine/ProcessingEngine';

export function renderExportPage(): HTMLElement {
  const page = el('div', { class: 'page export-page' });
  const source = getSource();
  if (!source) {
    page.innerHTML = '<p class="hint">请先导入素材。</p>';
    return page;
  }
  const metrics = store.get().metrics;
  page.innerHTML = `
    <section class="card">
      <h2>导出修复后视频</h2>
      <p class="hint">编码器：${webCodecsSupported() ? 'WebCodecs VideoEncoder + MP4 封装（H.264）' : 'MediaRecorder 回退（WebM/VP9）'}</p>
      <div class="row wrap">
        <label>码率(Mbps) <input type="number" id="bitrate" value="12" min="2" max="80" step="1"></label>
        <button id="btn-export" class="primary">开始导出</button>
        <span id="export-status" class="hint"></span>
      </div>
      <div class="progress-track"><div id="progress-bar" class="progress-bar"></div></div>
      <video id="result-video" controls hidden></video>
    </section>
    <section class="card">
      <h3>最终质量报告</h3>
      ${metrics ? `
      <table class="qa-table">
        <tr><td>屏外改动像素比例（阈值 ≤ 0.5%）</td><td>${(metrics.outsideChangedFraction * 100).toFixed(3)}%</td></tr>
        <tr><td>广告文字对比度比（要求 ≥ 1.000）</td><td>${metrics.textContrastRatio.toFixed(3)}</td></tr>
        <tr><td>闪烁衰减</td><td>${metrics.flickerAttenuationDb.toFixed(1)} dB</td></tr>
        <tr><td>遮挡泄漏（平均通道差 /255）</td><td>${metrics.occlusionLeak.toFixed(2)}</td></tr>
      </table>` : '<p class="hint">尚未运行质量评估，可返回预览页执行。</p>'}
      <button id="btn-back">← 返回预览</button>
    </section>
  `;

  page.querySelector<HTMLButtonElement>('#btn-back')!.addEventListener('click', () => navigate('preview'));
  page.querySelector<HTMLButtonElement>('#btn-export')!.addEventListener('click', async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    const status = page.querySelector<HTMLElement>('#export-status')!;
    const bar = page.querySelector<HTMLElement>('#progress-bar')!;
    try {
      let engine = getEngine();
      if (!engine || engine.source !== source) engine = new ProcessingEngine(source);
      const bitrate = Number(page.querySelector<HTMLInputElement>('#bitrate')!.value) * 1_000_000;
      status.textContent = '编码中…';
      const blob = await exportProcessedMp4(engine, {
        ...DEFAULT_EXPORT_OPTIONS,
        bitrate,
        onProgress: (f) => {
          bar.style.width = `${(f * 100).toFixed(1)}%`;
          status.textContent = `编码进度 ${(f * 100).toFixed(0)}%`;
        },
      });
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const base = store.get().clip?.name.replace(/\.[^.]+$/, '') ?? 'clip';
      downloadBlob(blob, `${base}-restored.${ext}`);
      const video = page.querySelector<HTMLVideoElement>('#result-video')!;
      video.hidden = false;
      video.src = URL.createObjectURL(blob);
      status.textContent = `导出完成（${(blob.size / 1_048_576).toFixed(1)} MB），已开始下载`;
      store.logLine(`导出 ${base}-restored.${ext}，${(blob.size / 1_048_576).toFixed(1)} MB`);
    } catch (err) {
      status.textContent = `导出失败：${(err as Error).message}`;
    } finally {
      btn.disabled = false;
    }
  });
  return page;
}
