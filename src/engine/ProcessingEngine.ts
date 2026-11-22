/**
 * ProcessingEngine — drives one FrameSource through the analysis
 * pipeline and the WebGL2 renderer, owns the working canvas/textures
 * and collects GPU timing samples.
 */

import { AnalysisPipeline, defaultPipelineOptions } from '../analysis/pipeline';
import type { GridFrame } from '../analysis/frameBuffer';
import { RestorationRenderer } from '../gl/RestorationRenderer';
import type { FrameSource } from '../media/frameSource';
import { store } from '../state/store';
import type { FrameAnalysis } from '../types';

export class ProcessingEngine {
  readonly source: FrameSource;
  readonly renderer: RestorationRenderer;
  readonly pipeline: AnalysisPipeline;
  private frameTex: WebGLTexture;
  private frameCanvas: HTMLCanvasElement;
  private gpuSamples: number[] = [];

  constructor(source: FrameSource) {
    this.source = source;
    const s = store.get().settings;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    this.frameCanvas = canvas;
    this.renderer = new RestorationRenderer(
      canvas,
      source.width,
      source.height,
      s.analysisGridCols,
      s.analysisGridRows,
      {
        featherPx: s.featherPx,
        contrastGuardRadius: s.contrastGuardRadius,
        contrastGuardEpsilon: s.contrastGuardEpsilon,
        compensationStrength: s.compensationStrength,
      },
    );
    this.frameTex = this.renderer.createFrameTexture();
    this.pipeline = new AnalysisPipeline(
      s.analysisGridCols,
      s.analysisGridRows,
      source.width,
      source.height,
      source.fps,
      defaultPipelineOptions(source.fps, s),
    );
  }

  /**
   * Ingest a frame: upload to GL, downsample for analysis, run pipeline.
   * Returns the FrameAnalysis once available (may be null during the
   * initial collection window).
   */
  async ingestFrame(index: number): Promise<FrameAnalysis | null> {
    const image = await this.source.frameImage(index);
    this.renderer.uploadFrameTexture(this.frameTex, image);
    const { rgb, luma } = this.renderer.readDownsampledGrid(this.frameTex);
    const grid: GridFrame = {
      frameIndex: index,
      timeSec: index / this.source.fps,
      rgb,
      luma,
    };
    this.pipeline.ingest(grid);
    return this.pipeline.getFrameAnalysis(index);
  }

  /**
   * Render the processed version of a frame. The frame must already have
   * been ingested. Returns wall-clock GPU path time in ms.
   */
  renderProcessed(index: number, toScreen: boolean): number {
    const analysis = this.pipeline.getFrameAnalysis(index);
    if (!analysis) {
      // Before detection: show the original untouched.
      const gl = this.renderer.gl;
      if (toScreen) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.renderer.width, this.renderer.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      return 0;
    }
    const hz = this.pipeline.regions.map((r) => r.beat?.frequencyHz ?? 0);
    const ms = this.renderer.render(
      this.frameTex,
      analysis,
      this.pipeline.occlusionGrid,
      hz,
      toScreen,
    );
    this.gpuSamples.push(ms);
    return ms;
  }

  /** Full analysis pass over the whole clip (detection + tracking + beat). */
  async analyzeAll(onProgress?: (fraction: number) => void): Promise<void> {
    const n = this.source.frameCount;
    for (let i = 0; i < n; i++) {
      await this.ingestFrame(i);
      onProgress?.((i + 1) / n);
    }
    store.update({
      regions: this.pipeline.regions.map((r) => ({ ...r })),
    });
  }

  get outputTexture(): WebGLTexture {
    return this.renderer.outputTexture;
  }

  get frameTexture(): WebGLTexture {
    return this.frameTex;
  }

  get canvas(): HTMLCanvasElement {
    return this.frameCanvas;
  }

  get gpuMsSamples(): number[] {
    return this.gpuSamples;
  }

  dispose(): void {
    this.renderer.dispose();
    this.source.release();
  }
}
