/**
 * Screen-region tracker.
 *
 * A camera pan moves every board with the same global motion. Each region
 * carries a reference luma template (its cells in the detection frame);
 * every new frame we search a small displacement window by SAD, refine
 * sub-cell position parabolically, and reconcile all regions against the
 * median motion so a player walking past one board cannot drag it away.
 */

import { rasterizeCells, quadToFlat } from './geometry';
import type { GridFrame } from './frameBuffer';
import type { ScreenRegion } from '../types';

export interface TrackOptions {
  /** Search radius in grid cells each axis. */
  searchRadiusCells: number;
  /** EMA smoothing factor for accepted motions. */
  smoothing: number;
  /** Max jump per frame in cells before the estimate is distrusted. */
  maxJumpCells: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  searchRadiusCells: 8,
  smoothing: 0.5,
  maxJumpCells: 4,
};

interface RegionTrackState {
  templateCells: number[];
  templateLuma: Float32Array;
  /** Current cumulative displacement in grid cells, relative to base polygon. */
  dxCells: number;
  dyCells: number;
  stuckCount: number;
  lastSad: number;
}

export class ScreenTracker {
  private states: RegionTrackState[] = [];
  readonly opts: TrackOptions;

  constructor(opts: TrackOptions = DEFAULT_TRACK_OPTIONS) {
    this.opts = opts;
  }

  init(regions: ScreenRegion[], ref: GridFrame, cols: number, rows: number): void {
    this.states = regions.map((r) => {
      const cells = rasterizeCells(quadToFlat(r.basePolygon), cols, rows);
      const luma = new Float32Array(cells.length);
      for (let i = 0; i < cells.length; i++) luma[i] = ref.luma[cells[i]!]!;
      return {
        templateCells: cells,
        templateLuma: luma,
        dxCells: 0,
        dyCells: 0,
        stuckCount: 0,
        lastSad: Infinity,
      };
    });
  }

  get displacementCells(): Array<[number, number]> {
    return this.states.map((s) => [s.dxCells, s.dyCells]);
  }

  private sad(frame: GridFrame, st: RegionTrackState, dx: number, dy: number, cols: number, rows: number): number {
    const { luma } = frame;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < st.templateCells.length; i++) {
      const cell = st.templateCells[i]!;
      const cx = (cell % cols) + dx;
      const cy = ((cell / cols) | 0) + dy;
      if (cx < 0.5 || cy < 0.5 || cx > cols - 0.5 || cy > rows - 0.5) continue;
      // Bilinear sample of the grid.
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const fx = cx - x0;
      const fy = cy - y0;
      const i00 = y0 * cols + x0;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      const v =
        (luma[i00] ?? 0) * (1 - fx) * (1 - fy) +
        (luma[i10] ?? 0) * fx * (1 - fy) +
        (luma[i01] ?? 0) * (1 - fx) * fy +
        (luma[i11] ?? 0) * fx * fy;
      sum += Math.abs(v - st.templateLuma[i]!);
      n++;
    }
    return n ? sum / n : Infinity;
  }

  private refine(frame: GridFrame, st: RegionTrackState, cols: number, rows: number): [number, number, number] {
    const r = this.opts.searchRadiusCells;
    let bestDx = 0;
    let bestDy = 0;
    let bestSad = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const s = this.sad(frame, st, st.dxCells + dx, st.dyCells + dy, cols, rows);
        if (s < bestSad) {
          bestSad = s;
          bestDx = st.dxCells + dx;
          bestDy = st.dyCells + dy;
        }
      }
    }
    // Sub-cell parabolic refinement along each axis.
    const sx = this.sad(frame, st, bestDx - 1, bestDy, cols, rows);
    const s0 = bestSad;
    const sxp = this.sad(frame, st, bestDx + 1, bestDy, cols, rows);
    const denomX = sx - 2 * s0 + sxp;
    const shiftX = denomX !== 0 ? 0.5 * (sx - sxp) / denomX : 0;
    const sy = this.sad(frame, st, bestDx, bestDy - 1, cols, rows);
    const syp = this.sad(frame, st, bestDx, bestDy + 1, cols, rows);
    const denomY = sy - 2 * s0 + syp;
    const shiftY = denomY !== 0 ? 0.5 * (sy - syp) / denomY : 0;
    return [bestDx + Math.max(-0.5, Math.min(0.5, shiftX)),
      bestDy + Math.max(-0.5, Math.min(0.5, shiftY)), bestSad];
  }

  /**
   * Advance one frame. Returns per-region pixel displacement from the
   * reference frame, ordered like `regions`.
   */
  update(frame: GridFrame, cols: number, rows: number, frameW: number, frameH: number): Array<[number, number]> {
    const raw: Array<[number, number, number]> = [];
    for (const st of this.states) {
      const [rx, ry, sadVal] = this.refine(frame, st, cols, rows);
      raw.push([rx, ry, sadVal]);
    }
    // Median global motion: a pan moves all boards together.
    const steps = raw.map((r, i) => [r[0] - this.states[i]!.dxCells, r[1] - this.states[i]!.dyCells] as [number, number]);
    const medDx = median(steps.map((s) => s[0]));
    const medDy = median(steps.map((s) => s[1]));
    const out: Array<[number, number]> = [];
    for (let i = 0; i < this.states.length; i++) {
      const st = this.states[i]!;
      const [rx, ry, sadVal] = raw[i]!;
      const stepX = rx - st.dxCells;
      const stepY = ry - st.dyCells;
      const deviates = Math.hypot(stepX - medDx, stepY - medDy) > this.opts.maxJumpCells;
      let targetX: number;
      let targetY: number;
      if (deviates) {
        // Occlusion / local failure: trust the shared pan instead.
        targetX = st.dxCells + medDx;
        targetY = st.dyCells + medDy;
        st.stuckCount++;
      } else {
        targetX = rx;
        targetY = ry;
        st.stuckCount = sadVal >= st.lastSad ? st.stuckCount + 1 : 0;
      }
      st.lastSad = sadVal;
      const a = this.opts.smoothing;
      st.dxCells += (targetX - st.dxCells) * a;
      st.dyCells += (targetY - st.dyCells) * a;
      const pxPerCellX = frameW / cols;
      const pxPerCellY = frameH / rows;
      out.push([st.dxCells * pxPerCellX, st.dyCells * pxPerCellY]);
    }
    return out;
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) * 0.5;
}
