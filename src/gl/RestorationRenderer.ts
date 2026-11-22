/**
 * RestorationRenderer — owns all WebGL2 resources and runs the
 * per-frame compensation graph:
 *
 *   input frame -> [downsample grid] (analysis, read back to CPU)
 *   input frame -> mask FBO (region SDF - occlusion)
 *   input frame -> meanH -> meanV (local contrast guard)
 *   frame + mask + mean -> composite FBO -> display / export
 */

import {
  linkProgram,
  createFullscreenVao,
  createFbo,
  createTexture,
  GpuTimer,
  u,
  type Fbo,
} from './glUtils';
import { FULLSCREEN_VS, DOWNSAMPLE_FS, MASK_FS, MEAN_FS, COMPOSITE_FS } from './shaders';
import type { FrameAnalysis } from '../types';

const MAX_REGIONS = 8;

export interface RendererSettings {
  featherPx: number;
  contrastGuardRadius: number;
  contrastGuardEpsilon: number;
  compensationStrength: number;
}

export class RestorationRenderer {
  readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private downsampleProg;
  private maskProg;
  private meanProg;
  private compositeProg;
  private maskFbo: Fbo;
  private meanHFbo: Fbo;
  private meanVFbo: Fbo;
  private outFbo: Fbo;
  private gridTex: WebGLTexture;
  private occTex: WebGLTexture;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly width: number;
  readonly height: number;
  readonly timer: GpuTimer;
  settings: RendererSettings;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    gridCols: number,
    gridRows: number,
    settings: RendererSettings,
  ) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.gridCols = gridCols;
    this.gridRows = gridRows;
    this.settings = settings;
    canvas.width = width;
    canvas.height = height;

    this.vao = createFullscreenVao(gl);
    this.downsampleProg = linkProgram(gl, FULLSCREEN_VS, DOWNSAMPLE_FS, ['uFrame', 'uGridSize']);
    this.maskProg = linkProgram(gl, FULLSCREEN_VS, MASK_FS, [
      'uRegions', 'uQuad0', 'uQuad1', 'uRegionCount',
      'uFeatherPx', 'uFrameSize', 'uOcclusion', 'uGridSize',
    ]);
    this.meanProg = linkProgram(gl, FULLSCREEN_VS, MEAN_FS, ['uSrc', 'uDirection', 'uRadius']);
    this.compositeProg = linkProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, [
      'uFrame', 'uMask', 'uMean', 'uRegionCount', 'uBBox', 'uBeat',
      'uTimeSec', 'uStrength', 'uEpsilon', 'uFrameSize',
    ]);

    this.maskFbo = createFbo(gl, width, height, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.meanHFbo = createFbo(gl, width, height);
    this.meanVFbo = createFbo(gl, width, height);
    this.outFbo = createFbo(gl, width, height);
    this.gridTex = createTexture(gl, gridCols, gridRows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.occTex = createTexture(gl, gridCols, gridRows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.timer = new GpuTimer(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  /** Upload the current source frame into an external texture. */
  uploadFrameTexture(texture: WebGLTexture, source: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Canvas/video rows are top-left first; GL textures are bottom-left.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  createFrameTexture(): WebGLTexture {
    return createTexture(this.gl, this.width, this.height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.gl.LINEAR);
  }

  /** Render the downsample grid and read it back as RGBA floats 0..1. */
  readDownsampledGrid(frameTex: WebGLTexture): { rgb: Float32Array; luma: Float32Array } {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.gridCols, this.gridRows);
    // Render into gridTex via an FBO.
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.gridTex, 0);
    gl.useProgram(this.downsampleProg.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.uniform1i(u(this.downsampleProg, "uFrame"), 0);
    gl.uniform2f(u(this.downsampleProg, "uGridSize"), this.gridCols, this.gridRows);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const raw = new Uint8Array(this.gridCols * this.gridRows * 4);
    gl.readPixels(0, 0, this.gridCols, this.gridRows, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.deleteFramebuffer(fbo);
    const rgb = new Float32Array(this.gridCols * this.gridRows * 3);
    const luma = new Float32Array(this.gridCols * this.gridRows);
    const rowBytes = this.gridCols * 4;
    for (let gy = 0; gy < this.gridRows; gy++) {
      // Flip GL bottom-origin rows back to top-origin for analysis.
      const srcRow = this.gridRows - 1 - gy;
      for (let gx = 0; gx < this.gridCols; gx++) {
        const dst = gy * this.gridCols + gx;
        const ri = srcRow * rowBytes + gx * 4;
        const r = raw[ri]! / 255;
        const g = raw[ri + 1]! / 255;
        const b = raw[ri + 2]! / 255;
        rgb[dst * 3] = r;
        rgb[dst * 3 + 1] = g;
        rgb[dst * 3 + 2] = b;
        luma[dst] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
    }
    gl.viewport(0, 0, this.width, this.height);
    return { rgb, luma };
  }

  private uploadOcclusion(grid: Float32Array): void {
    const gl = this.gl;
    const bytes = new Uint8Array(this.gridCols * this.gridRows * 4);
    for (let i = 0; i < this.gridCols * this.gridRows; i++) {
      const v = Math.round(Math.min(1, Math.max(0, grid[i]!)) * 255);
      bytes[i * 4] = v;
      bytes[i * 4 + 1] = v;
      bytes[i * 4 + 2] = v;
      bytes[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.occTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.gridCols, this.gridRows, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  }

  private buildPolygonUniforms(analysis: FrameAnalysis) {
    const regions = new Float32Array(MAX_REGIONS * 4);
    const quad0 = new Float32Array(MAX_REGIONS * 4);
    const quad1 = new Float32Array(MAX_REGIONS * 4);
    const bbox = new Float32Array(MAX_REGIONS * 4);
    const beat = new Float32Array(MAX_REGIONS * 4);
    const count = Math.min(analysis.polygons.length, MAX_REGIONS);
    for (let r = 0; r < count; r++) {
      const poly = analysis.polygons[r]!;
      // Use the first four vertices; every region is a quad.
      const verts = poly.points.slice(0, 4);
      const glPts = verts.map(([x, yTop]): [number, number] => [x, this.height - yTop]);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, yGl] of glPts) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, yGl);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, yGl);
      }
      regions[r * 4] = minX;
      regions[r * 4 + 1] = minY;
      regions[r * 4 + 2] = maxX;
      regions[r * 4 + 3] = maxY;
      bbox[r * 4] = minX;
      bbox[r * 4 + 1] = minY;
      bbox[r * 4 + 2] = maxX;
      bbox[r * 4 + 3] = maxY;
      const p0 = glPts[0] ?? [0, 0];
      const p1 = glPts[1] ?? [0, 0];
      const p2 = glPts[2] ?? [0, 0];
      const p3 = glPts[3] ?? [0, 0];
      quad0[r * 4] = p0[0];
      quad0[r * 4 + 1] = p0[1];
      quad0[r * 4 + 2] = p1[0];
      quad0[r * 4 + 3] = p1[1];
      quad1[r * 4] = p2[0];
      quad1[r * 4 + 1] = p2[1];
      quad1[r * 4 + 2] = p3[0];
      quad1[r * 4 + 3] = p3[1];
      const st = analysis.stripe[r]!;
      // uBeat layout: [hz, amplitude, temporalPhase, slopeV]; hz filled in render().
      beat[r * 4] = 0;
      beat[r * 4 + 1] = st.amplitude;
      beat[r * 4 + 2] = st.phase;
      beat[r * 4 + 3] = st.slope;
    }
    return { regions, quad0, quad1, bbox, beat, count };
  }

  /**
   * Full compensation graph for one frame.
   * `beatHz` carries per-region flicker frequency (analysis output).
   */
  render(
    frameTex: WebGLTexture,
    analysis: FrameAnalysis,
    occlusionGrid: Float32Array,
    beatHz: number[],
    toScreen: boolean,
  ): number {
    const gl = this.gl;
    const t0 = performance.now();
    this.timer.begin();
    this.uploadOcclusion(occlusionGrid);
    const uniforms = this.buildPolygonUniforms(analysis);
    const hz = beatHz;

    // Pass 1: mask.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFbo.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.maskProg.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex);
    gl.uniform1i(u(this.maskProg, "uOcclusion"), 0);
    gl.uniform4fv(u(this.maskProg, "uRegions"), uniforms.regions);
    gl.uniform4fv(u(this.maskProg, "uQuad0"), uniforms.quad0);
    gl.uniform4fv(u(this.maskProg, "uQuad1"), uniforms.quad1);
    gl.uniform1i(u(this.maskProg, "uRegionCount"), uniforms.count);
    gl.uniform1f(u(this.maskProg, "uFeatherPx"), this.settings.featherPx);
    gl.uniform2f(u(this.maskProg, "uFrameSize"), this.width, this.height);
    gl.uniform2f(u(this.maskProg, "uGridSize"), this.gridCols, this.gridRows);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2a/2b: separable local mean.
    gl.useProgram(this.meanProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.uniform1i(u(this.meanProg, "uSrc"), 0);
    gl.uniform1i(u(this.meanProg, "uRadius"), this.settings.contrastGuardRadius);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meanHFbo.fbo);
    gl.uniform2f(u(this.meanProg, "uDirection"), 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, this.meanHFbo.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meanVFbo.fbo);
    gl.uniform2f(u(this.meanProg, "uDirection"), 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 3: composite.
    gl.useProgram(this.compositeProg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameTex);
    gl.uniform1i(u(this.compositeProg, "uFrame"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskFbo.texture);
    gl.uniform1i(u(this.compositeProg, "uMask"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.meanVFbo.texture);
    gl.uniform1i(u(this.compositeProg, "uMean"), 2);
    gl.uniform1i(u(this.compositeProg, "uRegionCount"), uniforms.count);
    gl.uniform4fv(u(this.compositeProg, "uBBox"), uniforms.bbox);
    const beatPacked = uniforms.beat;
    for (let r = 0; r < uniforms.count; r++) beatPacked[r * 4] = hz[r] ?? 0;
    gl.uniform4fv(u(this.compositeProg, "uBeat"), beatPacked);
    gl.uniform1f(u(this.compositeProg, "uTimeSec"), analysis.timeSec);
    gl.uniform1f(u(this.compositeProg, "uStrength"), this.settings.compensationStrength);
    gl.uniform1f(u(this.compositeProg, "uEpsilon"), this.settings.contrastGuardEpsilon);
    gl.uniform2f(u(this.compositeProg, "uFrameSize"), this.width, this.height);
    if (toScreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFbo.fbo);
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.timer.end();
    this.timer.poll();
    return performance.now() - t0;
  }

  get outputTexture(): WebGLTexture {
    return this.outFbo.texture;
  }

  /** Read back the composite FBO as RGBA bytes (for CPU-side QA). */
  readOutput(): Uint8ClampedArray {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFbo.fbo);
    const data = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    // GL origin is bottom-left; flip rows for ImageData conventions.
    const flipped = new Uint8ClampedArray(data.length);
    const rowBytes = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      flipped.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), (this.height - 1 - y) * rowBytes);
    }
    return flipped;
  }

  dispose(): void {
    const gl = this.gl;
    for (const o of [this.maskFbo, this.meanHFbo, this.meanVFbo, this.outFbo]) {
      gl.deleteTexture(o.texture);
      gl.deleteFramebuffer(o.fbo);
    }
    gl.deleteTexture(this.gridTex);
    gl.deleteTexture(this.occTex);
    gl.deleteVertexArray(this.vao);
  }
}
