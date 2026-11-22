/**
 * Ring buffer of downsampled per-frame grids (RGB + luma) with
 * temporal statistics helpers. All analysis runs at grid resolution
 * so the per-frame CPU cost stays independent of video resolution.
 */

export interface GridFrame {
  frameIndex: number;
  timeSec: number;
  rgb: Float32Array;
  luma: Float32Array;
}

export class TemporalGrid {
  readonly cols: number;
  readonly rows: number;
  readonly capacity: number;
  private buf: GridFrame[] = [];
  private head = 0;
  private count = 0;

  constructor(cols: number, rows: number, capacity = 512) {
    this.cols = cols;
    this.rows = rows;
    this.capacity = capacity;
  }

  get length(): number {
    return this.count;
  }

  /** Chronological frames, oldest first. */
  frames(): GridFrame[] {
    if (this.count < this.capacity) return this.buf.slice(0, this.count);
    const out: GridFrame[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.buf[(this.head + i) % this.capacity]!);
    return out;
  }

  latest(): GridFrame | null {
    if (this.count === 0) return null;
    const idx = (this.head + this.count - 1) % this.capacity;
    return this.buf[idx]!;
  }

  push(frame: GridFrame): void {
    if (this.count < this.capacity) {
      this.buf[this.count] = frame;
      this.count++;
      return;
    }
    this.buf[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Chronological luma series of one cell. */
  lumaSeries(cell: number): Float32Array {
    const out = new Float32Array(this.count);
    const all = this.frames();
    for (let i = 0; i < all.length; i++) out[i] = all[i]!.luma[cell]!;
    return out;
  }

  /** Temporal median luma of one cell (flicker averages out across cycles). */
  medianLuma(cell: number): number {
    const s = this.lumaSeries(cell);
    const a = Array.from(s).sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) * 0.5;
  }

  meanLuma(cell: number): number {
    let s = 0;
    const all = this.frames();
    for (const f of all) s += f.luma[cell]!;
    return all.length ? s / all.length : 0;
  }

  temporalVariance(cell: number): number {
    const all = this.frames();
    if (all.length < 2) return 0;
    const m = this.meanLuma(cell);
    let s = 0;
    for (const f of all) {
      const d = f.luma[cell]! - m;
      s += d * d;
    }
    return s / (all.length - 1);
  }
}
