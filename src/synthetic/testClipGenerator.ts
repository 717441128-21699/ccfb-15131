/**
 * Synthetic basketball-broadcast test clip generator.
 *
 * Renders deterministic frames onto an offscreen canvas with a known
 * ground-truth LED board model, so the whole pipeline can be validated
 * without real footage:
 *
 *   board emission  e(t, y) = base(x,y) * (1 + A * sin(2*pi*f_ref*t + phi_s*y))
 *   captured board  = time integral over the open shutter interval,
 *                     which naturally produces both flicker and rolling
 *                     dark bands whose beat frequency is |f_ref - f_cam|.
 *
 * Also renders a moving "player" sprite that crosses in front of the
 * board to exercise occlusion handling, and exposes ground-truth masks.
 */

export interface ShutterSpec {
  id: string;
  label: string;
  /** Shutter angle in degrees; open fraction = angle/360. */
  shutterAngleDeg: number;
}

export interface RefreshSpec {
  id: string;
  label: string;
  refreshHz: number;
}

export const SHUTTER_SPECS: ShutterSpec[] = [
  { id: 's90', label: '90° (1/4)', shutterAngleDeg: 90 },
  { id: 's180', label: '180° (1/2)', shutterAngleDeg: 180 },
  { id: 's270', label: '270° (3/4)', shutterAngleDeg: 270 },
  { id: 's360', label: '360° (1/1)', shutterAngleDeg: 360 },
];

export const REFRESH_SPECS: RefreshSpec[] = [
  { id: 'r192', label: '192 Hz', refreshHz: 192 },
  { id: 'r240', label: '240 Hz', refreshHz: 240 },
  { id: 'r300', label: '300 Hz', refreshHz: 300 },
  { id: 'r384', label: '384 Hz', refreshHz: 384 },
  { id: 'r480', label: '480 Hz', refreshHz: 480 },
  { id: 'r600', label: '600 Hz', refreshHz: 600 },
];

/** 24 shutter x refresh combinations, as required. */
export const FULL_MATRIX = SHUTTER_SPECS.flatMap((s) =>
  REFRESH_SPECS.map((r) => ({ shutter: s, refresh: r, id: `${s.id}_${r.id}` })));

export interface TestClipConfig {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  shutter: ShutterSpec;
  refresh: RefreshSpec;
  /** Flicker depth as a fraction of board brightness. */
  flickerAmplitude: number;
  /** Spatial cycles of the rolling band across the board height. */
  stripeCycles: number;
  /** Simulated camera pan speed in px/frame. */
  panPxPerFrame: number;
  /** Include a player crossing the board. */
  withPlayer: boolean;
  seed: number;
}

export const DEFAULT_CLIP_CONFIG: TestClipConfig = {
  width: 1920,
  height: 1080,
  fps: 30,
  frameCount: 180,
  shutter: SHUTTER_SPECS[1]!,
  refresh: REFRESH_SPECS[1]!,
  flickerAmplitude: 0.35,
  stripeCycles: 1.5,
  panPxPerFrame: 1.2,
  withPlayer: true,
  seed: 42,
};

export interface BoardGroundTruth {
  /** Board polygon in frame pixels at frame 0 (before pan). */
  basePolygon: [number, number][];
  /** True beat frequency visible to the camera. */
  beatHz: number;
  amplitude: number;
}

/** Tiny deterministic PRNG so clips are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TestClipGenerator {
  readonly cfg: TestClipConfig;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private boardPattern: HTMLCanvasElement;
  readonly groundTruth: BoardGroundTruth;
  private board: { x: number; y: number; w: number; h: number };

  constructor(cfg: TestClipConfig) {
    this.cfg = cfg;
    this.canvas = document.createElement('canvas');
    this.canvas.width = cfg.width;
    this.canvas.height = cfg.height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.board = {
      x: Math.round(cfg.width * 0.08),
      y: Math.round(cfg.height * 0.62),
      w: Math.round(cfg.width * 0.84),
      h: Math.round(cfg.height * 0.16),
    };
    this.boardPattern = this.buildBoardPattern();
    const beat = Math.abs(cfg.refresh.refreshHz - Math.round(cfg.refresh.refreshHz / cfg.fps) * cfg.fps);
    this.groundTruth = {
      basePolygon: [
        [this.board.x, this.board.y],
        [this.board.x + this.board.w, this.board.y],
        [this.board.x + this.board.w, this.board.y + this.board.h],
        [this.board.x, this.board.y + this.board.h],
      ],
      // When refresh is an exact multiple of fps the sampled beat aliases to
      // the refresh harmonic; expose the raw difference and let the estimator
      // report what the camera actually sees.
      beatHz: beat === 0 ? cfg.fps / 2 : beat,
      amplitude: cfg.flickerAmplitude,
    };
  }

  private buildBoardPattern(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.board.w;
    c.height = this.board.h;
    const g = c.getContext('2d')!;
    const rnd = mulberry32(this.cfg.seed);
    g.fillStyle = '#0b1d3a';
    g.fillRect(0, 0, c.width, c.height);
    // Alternating sponsor panels with high-contrast ad text.
    const panels = 5;
    const pw = c.width / panels;
    const words = ['SPARK', 'RIVER', 'NOVA', 'PIZZA', 'GO!'];
    const colors = ['#143a73', '#0f2c57', '#173f7d', '#10325f', '#1a4383'];
    for (let i = 0; i < panels; i++) {
      g.fillStyle = colors[i]!;
      g.fillRect(i * pw, 0, pw + 1, c.height);
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.strokeRect(i * pw, 0, pw, c.height);
      g.fillStyle = rnd() > 0.5 ? '#ffd23f' : '#ffffff';
      g.font = `bold ${Math.round(c.height * 0.52)}px Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(words[i]!, i * pw + pw / 2, c.height * 0.52);
    }
    // LED pixel lattice so the board texture differs from the court.
    g.globalAlpha = 0.18;
    g.fillStyle = '#000';
    for (let y = 0; y < c.height; y += 4) {
      for (let x = (y / 4) % 2 ? 2 : 0; x < c.width; x += 4) g.fillRect(x, y, 2, 2);
    }
    g.globalAlpha = 1;
    return c;
  }

  /**
   * Average board gain over the shutter interval, integrating the LED
   * emission sinusoid numerically (8 samples).
   */
  private shutterGain(tCenter: number, boardY: number): number {
    const openFraction = this.cfg.shutter.shutterAngleDeg / 360;
    const half = openFraction / (2 * this.cfg.fps);
    const f = this.cfg.refresh.refreshHz;
    const A = this.cfg.flickerAmplitude;
    const k = (this.cfg.stripeCycles * Math.PI * 2) / this.board.h;
    let acc = 0;
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const t = tCenter - half + (2 * half * (i + 0.5)) / steps;
      const phase = 2 * Math.PI * f * t + k * boardY;
      acc += 1 + A * Math.sin(phase);
    }
    return acc / steps;
  }

  /** Per-pixel multiplicative gain map for one frame time. */
  private buildModulation(tCenter: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.board.w;
    c.height = this.board.h;
    const g = c.getContext('2d')!;
    const img = g.createImageData(this.board.w, this.board.h);
    for (let y = 0; y < this.board.h; y++) {
      const gain = this.shutterGain(tCenter, y + 0.5);
      // Multiply mode needs [0,1]; clamp the bright side but keep dark depth.
      const g01 = Math.max(0.05, Math.min(1, gain));
      const v = Math.round(g01 * 255);
      for (let x = 0; x < this.board.w; x++) {
        const i = (y * this.board.w + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** Render frame `index`; returns the canvas for immediate use. */
  renderFrame(index: number): { canvas: HTMLCanvasElement; timeSec: number; panX: number } {
    const { ctx, cfg } = this;
    const t = index / cfg.fps;
    const panX = index * cfg.panPxPerFrame;
    // Court background (static world, shifted by pan).
    const grad = ctx.createLinearGradient(0, 0, 0, cfg.height);
    grad.addColorStop(0, '#2a2530');
    grad.addColorStop(0.55, '#7a5a3a');
    grad.addColorStop(1, '#a9794c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cfg.width, cfg.height);
    // Floor planks.
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 2;
    for (let y = cfg.height * 0.55; y < cfg.height; y += 46) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cfg.width, y);
      ctx.stroke();
    }
    // Court lines.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 4;
    ctx.strokeRect(cfg.width * 0.18 - panX * 0.3, cfg.height * 0.7, cfg.width * 0.5, cfg.height * 0.26);

    // Board (moves with pan).
    const bx = this.board.x - panX;
    const by = this.board.y;
    // Draw the unmodulated board first, then apply a true multiplicative
    // per-pixel gain via a modulation canvas (linear-light, no alpha quantizing).
    ctx.drawImage(this.boardPattern, bx, by);
    const mod = this.buildModulation(t);
    const comp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(mod, bx, by);
    ctx.globalCompositeOperation = comp;

    // Player sprite crossing the board from left to right.
    if (cfg.withPlayer) {
      const start = -cfg.width * 0.12 - panX;
      const end = cfg.width * 0.55 - panX;
      const p = index / (cfg.frameCount - 1);
      const px = start + (end - start) * p;
      const py = by + this.board.h * 0.15;
      const ph = this.board.h * 2.6;
      const pw = ph * 0.42;
      ctx.fillStyle = '#c8342c';
      ctx.beginPath();
      ctx.arc(px + pw / 2, py, pw * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(px + pw * 0.18, py + pw * 0.3, pw * 0.64, ph * 0.5);
      ctx.fillStyle = '#f0d8c8';
      ctx.fillRect(px + pw * 0.28, py + ph * 0.5, pw * 0.18, ph * 0.34);
      ctx.fillRect(px + pw * 0.56, py + ph * 0.5, pw * 0.18, ph * 0.34);
    }
    return { canvas: this.canvas, timeSec: t, panX };
  }

  /** Ground-truth board polygon at a given frame (includes pan). */
  boardPolygonAt(index: number): [number, number][] {
    const panX = index * this.cfg.panPxPerFrame;
    return this.groundTruth.basePolygon.map(([x, y]) => [x - panX, y] as [number, number]);
  }

  /**
   * Ground-truth screen mask (1 inside the board, 0 outside) at frame
   * resolution. Occlusion by the player is NOT included — call
   * playerMaskAt for that.
   */
  boardMaskAt(index: number): Uint8Array {
    const { width, height } = this.cfg;
    const mask = new Uint8Array(width * height);
    const poly = this.boardPolygonAt(index);
    const [x0, y0] = poly[0]!;
    const [x1, y1] = poly[2]!;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x++) {
        mask[y * width + x] = 1;
      }
    }
    return mask;
  }

  /** Player sprite occupancy mask (1 where the player covers pixels). */
  playerMaskAt(index: number): Uint8Array {
    const { width, height } = this.cfg;
    const mask = new Uint8Array(width * height);
    if (!this.cfg.withPlayer) return mask;
    const panX = index * this.cfg.panPxPerFrame;
    const by = this.board.y;
    const start = -width * 0.12 - panX;
    const end = width * 0.55 - panX;
    const p = index / (this.cfg.frameCount - 1);
    const px = start + (end - start) * p;
    const py = by + this.board.h * 0.15;
    const ph = this.board.h * 2.6;
    const pw = ph * 0.42;
    const x0 = Math.max(0, Math.floor(px));
    const x1 = Math.min(width, Math.ceil(px + pw));
    const y0 = Math.max(0, Math.floor(py - pw * 0.34));
    const y1 = Math.min(height, Math.ceil(py + ph * 0.85));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) mask[y * width + x] = 1;
    }
    return mask;
  }

  /** Clean (flicker-free, stripe-free) ideal board image for QA reference. */
  renderCleanFrame(index: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.cfg.width;
    c.height = this.cfg.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.renderFrame(index).canvas, 0, 0);
    // Repaint the board region with the unmodulated pattern.
    const panX = index * this.cfg.panPxPerFrame;
    ctx.drawImage(this.boardPattern, this.board.x - panX, this.board.y);
    return c;
  }
}
