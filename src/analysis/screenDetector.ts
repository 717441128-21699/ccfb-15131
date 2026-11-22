/**
 * Automatic LED-screen detection on the analysis grid.
 *
 * Per-cell evidence:
 *   - temporal flicker energy (LED boards pulse, court/players do not)
 *   - spectral coherence (a board's pulse is a narrow-band beat signal)
 * Connected high-score cells are grouped; each component is reduced to a
 * maximum-area quadrilateral (boards seen in perspective are trapezoids).
 */

import { TemporalGrid } from './frameBuffer';
import { dominantFrequency, mean, stdev } from './mathUtils';
import type { Quad, ScreenRegion } from '../types';

export interface DetectionOptions {
  minComponentCells: number;
  /** Score threshold in standard deviations above the grid mean. */
  scoreSigma: number;
  minAbsoluteScore: number;
  fs: number;
  /** Frequencies below this are camera motion / exposure changes, not flicker. */
  minFlickerHz: number;
}

export const DEFAULT_DETECTION_OPTIONS: DetectionOptions = {
  minComponentCells: 24,
  scoreSigma: 1.2,
  minAbsoluteScore: 0.18,
  fs: 30,
  minFlickerHz: 2,
};

export interface CellScore {
  score: number;
  flicker: number;
  coherence: number;
  hz: number;
}

export function scoreCells(grid: TemporalGrid, opts: DetectionOptions): CellScore[] {
  const n = grid.cols * grid.rows;
  const out: CellScore[] = new Array(n);
  const flickers = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const series = grid.lumaSeries(c);
    const variance = grid.temporalVariance(c);
    const m = grid.meanLuma(c);
    const rel = m > 1e-3 ? Math.sqrt(variance) / m : 0;
    flickers[c] = rel;
    let coherence = 0;
    let hz = 0;
    if (rel > 0.01 && series.length >= 32) {
      const spec = dominantFrequency(series, opts.fs);
      if (spec.hz >= opts.minFlickerHz) {
        hz = spec.hz;
        let energy = 0;
        for (let i = 0; i < series.length; i++) energy += series[i]! * series[i]!;
        coherence = energy > 0 ? Math.min(1, (spec.magnitude * spec.magnitude * 2) / energy) : 0;
      }
    }
    out[c] = { score: 0, flicker: rel, coherence, hz };
  }
  const fMean = mean(flickers);
  const fStd = stdev(flickers) || 1e-6;
  const cValues = new Float64Array(n);
  for (let c = 0; c < n; c++) cValues[c] = out[c]!.coherence;
  const cMean = mean(cValues);
  const cStd = stdev(cValues) || 1e-6;
  for (let c = 0; c < n; c++) {
    const fn = (flickers[c]! - fMean) / fStd;
    const cn = (out[c]!.coherence - cMean) / cStd;
    // Squash to [0,1] with a soft sigmoid; only positive evidence counts.
    const fs0 = 1 / (1 + Math.exp(-fn));
    const cs0 = 1 / (1 + Math.exp(-cn * 1.5));
    const score = Math.max(0, fs0) * 0.55 + Math.max(0, cs0) * 0.45;
    out[c] = { ...out[c]!, score };
  }
  return out;
}

/** 8-connected components over cells whose score passes the threshold. */
export function labelComponents(
  scores: CellScore[],
  cols: number,
  rows: number,
  threshold: number,
): number[] {
  const labels = new Array<number>(cols * rows).fill(-1);
  const stack: number[] = [];
  let next = 0;
  for (let c = 0; c < cols * rows; c++) {
    if (labels[c] !== -1 || scores[c]!.score < threshold) continue;
    const label = next++;
    labels[c] = label;
    stack.push(c);
    while (stack.length) {
      const cur = stack.pop()!;
      const x = cur % cols;
      const y = (cur / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (labels[ni] === -1 && scores[ni]!.score >= threshold) {
            labels[ni] = label;
            stack.push(ni);
          }
        }
      }
    }
  }
  return labels;
}

/** Convex hull (Andrew's monotone chain) of cell-center points. */
export function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea(poly: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    a += x1 * y2 - y1 * x2;
  }
  return Math.abs(a) * 0.5;
}

/**
 * Maximum-area quadrilateral inscribed in a convex polygon.
 * O(h^3) — hulls at grid resolution are small and this runs once.
 */
export function maxAreaQuad(hull: Array<[number, number]>): Array<[number, number]> {
  const h = hull.length;
  if (h <= 4) return hull.slice();
  let best: Array<[number, number]> = hull.slice(0, 4);
  let bestArea = 0;
  const tri = (i: number, j: number, k: number) => {
    const a = hull[i]!;
    const b = hull[j]!;
    const c = hull[k]!;
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5;
  };
  for (let i = 0; i < h; i++) {
    for (let j = i + 2; j < h; j++) {
      // Best third vertex on each side of diagonal (i,j).
      let kBest = -1;
      let lBest = -1;
      let kArea = 0;
      let lArea = 0;
      for (let k = i + 1; k < j; k++) {
        const a = tri(i, j, k);
        if (a > kArea) {
          kArea = a;
          kBest = k;
        }
      }
      for (let l = j + 1; l < h + i - 1; l++) {
        const a = tri(i, j, l % h);
        if (a > lArea) {
          lArea = a;
          lBest = l % h;
        }
      }
      if (kBest < 0 || lBest < 0) continue;
      const area = kArea + lArea;
      if (area > bestArea) {
        bestArea = area;
        best = [hull[i]!, hull[kBest]!, hull[j]!, hull[lBest]!];
      }
    }
  }
  return best;
}

/** Expand a polygon outward by `pad` cell units (axis-aligned padding). */
function padPolygon(poly: Array<[number, number]>, pad: number): Array<[number, number]> {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of poly) {
    cx += x;
    cy += y;
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * pad, y + (dy / len) * pad];
  });
}

export function detectScreens(
  grid: TemporalGrid,
  opts: DetectionOptions,
): { regions: ScreenRegion[]; scoreGrid: Float32Array; scores: CellScore[] } {
  const scores = scoreCells(grid, opts);
  const raw = new Float64Array(scores.length);
  for (let i = 0; i < scores.length; i++) raw[i] = scores[i]!.score;
  const m = mean(raw);
  const sd = stdev(raw) || 1e-6;
  const threshold = Math.max(opts.minAbsoluteScore, m + opts.scoreSigma * sd);
  const labels = labelComponents(scores, grid.cols, grid.rows, threshold);
  const components = new Map<number, number[]>();
  for (let c = 0; c < labels.length; c++) {
    const l = labels[c]!;
    if (l < 0) continue;
    if (!components.has(l)) components.set(l, []);
    components.get(l)!.push(c);
  }
  const regions: ScreenRegion[] = [];
  const scoreGrid = new Float32Array(scores.length);
  for (let i = 0; i < scores.length; i++) scoreGrid[i] = scores[i]!.score;
  let id = 0;
  for (const cells of components.values()) {
    if (cells.length < opts.minComponentCells) continue;
    const pts = cells.map((c): [number, number] => [
      (c % grid.cols) + 0.5,
      ((c / grid.cols) | 0) + 0.5,
    ]);
    const hull = convexHull(pts);
    if (hull.length < 3) continue;
    const quadCells = maxAreaQuad(hull);
    const padded = padPolygon(quadCells, 1.2);
    const points: [number, number][] = padded.map(([x, y]) => [
      x / grid.cols,
      y / grid.rows,
    ]);
    const quad: Quad = { points };
    if (polygonArea(points) < 1e-4) continue;
    regions.push({
      id: `screen-${id++}`,
      basePolygon: quad,
      translation: [],
      featherPx: 2.5,
      beat: null,
    });
  }
  return { regions, scoreGrid, scores };
}
