/**
 * Polygon / grid geometry helpers shared by detection, tracking and the
 * calibration page. All normalized coordinates are in [0,1].
 */

import { pointInPolygon } from './mathUtils';
import type { PixelPolygon, Quad } from '../types';

export function quadToFlat(q: Quad): number[] {
  const out: number[] = [];
  for (const [x, y] of q.points) out.push(x, y);
  return out;
}

/** Cell indices whose centers fall inside the polygon. */
export function rasterizeCells(
  polyNorm: ArrayLike<number>,
  cols: number,
  rows: number,
): number[] {
  const flat: number[] = [];
  for (let k = 0; k < polyNorm.length; k += 2) {
    flat.push((polyNorm[k] as number) * cols, (polyNorm[k + 1] as number) * rows);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < flat.length; k += 2) {
    minX = Math.min(minX, flat[k]!);
    maxX = Math.max(maxX, flat[k]!);
    minY = Math.min(minY, flat[k + 1]!);
    maxY = Math.max(maxY, flat[k + 1]!);
  }
  const out: number[] = [];
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(cols - 1, Math.ceil(maxX));
  const y1 = Math.min(rows - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, flat)) out.push(y * cols + x);
    }
  }
  return out;
}

/** Translate a normalized polygon by pixel-space (dx,dy). */
export function translateQuad(q: Quad, dxPx: number, dyPx: number, frameW: number, frameH: number): Quad {
  return {
    points: q.points.map(([x, y]): [number, number] => [
      x + dxPx / frameW,
      y + dyPx / frameH,
    ]),
  };
}

export function quadToPixels(q: Quad, frameW: number, frameH: number): PixelPolygon {
  return { points: q.points.map(([x, y]) => [x * frameW, y * frameH] as [number, number]) };
}

export function polygonBBox(poly: ArrayLike<number>): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < poly.length; k += 2) {
    minX = Math.min(minX, poly[k]!);
    maxX = Math.max(maxX, poly[k]!);
    minY = Math.min(minY, poly[k + 1]!);
    maxY = Math.max(maxY, poly[k + 1]!);
  }
  return { minX, minY, maxX, maxY };
}

export function polygonCentroid(poly: ArrayLike<number>): [number, number] {
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < poly.length; k += 2) {
    cx += poly[k]!;
    cy += poly[k + 1]!;
  }
  const n = poly.length / 2;
  return [cx / n, cy / n];
}

/**
 * Signed-distance field of a convex-ish polygon at one sample point.
 * Negative inside, positive outside, magnitude in pixels.
 */
export function polygonSdf(
  x: number,
  y: number,
  polyPx: ArrayLike<number>,
): number {
  // Reuse pointInPolygon/distance helpers without circular imports.
  let inside = false;
  const n = polyPx.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polyPx[i * 2]!;
    const yi = polyPx[i * 2 + 1]!;
    const xj = polyPx[j * 2]!;
    const yj = polyPx[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  let d = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = polyPx[i * 2]!;
    const ay = polyPx[i * 2 + 1]!;
    const bx = polyPx[j * 2]!;
    const by = polyPx[j * 2 + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    d = Math.min(d, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return inside ? -d : d;
}
