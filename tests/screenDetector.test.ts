import { describe, it, expect } from 'vitest';
import { TemporalGrid } from '../src/analysis/frameBuffer';
import {
  convexHull,
  maxAreaQuad,
  labelComponents,
  detectScreens,
  scoreCells,
  DEFAULT_DETECTION_OPTIONS,
} from '../src/analysis/screenDetector';
import { TAU } from '../src/analysis/mathUtils';

function makeFlickerGrid(
  cols: number,
  rows: number,
  frames: number,
  fs: number,
  flickerCells: Set<number>,
  freqHz = 7,
): TemporalGrid {
  const grid = new TemporalGrid(cols, rows, frames + 4);
  for (let f = 0; f < frames; f++) {
    const rgb = new Float32Array(cols * rows * 3);
    const luma = new Float32Array(cols * rows);
    for (let c = 0; c < cols * rows; c++) {
      const base = 0.3 + ((c * 37) % 10) / 100;
      let v = base;
      if (flickerCells.has(c)) {
        v = base * (1 + 0.3 * Math.sin(TAU * freqHz * (f / fs)));
      }
      luma[c] = v;
      rgb[c * 3] = v * 0.6;
      rgb[c * 3 + 1] = v * 0.8;
      rgb[c * 3 + 2] = v;
    }
    grid.push({ frameIndex: f, timeSec: f / fs, rgb, luma });
  }
  return grid;
}

describe('geometry primitives', () => {
  it('convex hull of a square returns four corners', () => {
    const pts: Array<[number, number]> = [
      [0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1], [1, 1],
    ];
    const hull = convexHull(pts);
    expect(hull.length).toBe(4);
  });

  it('max-area quad of a hexagon keeps four vertices', () => {
    const hull = convexHull([
      [0, 0], [2, -1], [5, 0], [6, 3], [4, 6], [1, 5],
    ]);
    const quad = maxAreaQuad(hull);
    expect(quad.length).toBe(4);
  });
});

describe('labelComponents', () => {
  it('groups 8-connected cells', () => {
    const scores = [
      { score: 0.9, flicker: 0, coherence: 0, hz: 0 },
      { score: 0.8, flicker: 0, coherence: 0, hz: 0 },
      { score: 0.1, flicker: 0, coherence: 0, hz: 0 },
      { score: 0.85, flicker: 0, coherence: 0, hz: 0 },
    ];
    const labels = labelComponents(scores, 2, 2, 0.5);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[3]).toBe(labels[0]); // diagonal 8-connectivity
    expect(labels[2]).toBe(-1);
  });
});

describe('detectScreens', () => {
  it('detects a rectangular flickering region and ignores static cells', () => {
    const cols = 32;
    const rows = 18;
    const flicker = new Set<number>();
    for (let y = 8; y < 13; y++) {
      for (let x = 4; x < 26; x++) flicker.add(y * cols + x);
    }
    const grid = makeFlickerGrid(cols, rows, 128, 30, flicker, 6.5);
    const result = detectScreens(grid, { ...DEFAULT_DETECTION_OPTIONS, fs: 30, minComponentCells: 20 });
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
    const region = result.regions[0]!;
    const xs = region.basePolygon.points.map((p) => p[0] * cols);
    const ys = region.basePolygon.points.map((p) => p[1] * rows);
    expect(Math.min(...xs)).toBeLessThan(5.5);
    expect(Math.max(...xs)).toBeGreaterThan(24.5);
    expect(Math.min(...ys)).toBeLessThan(9);
    expect(Math.max(...ys)).toBeGreaterThan(12);
  });

  it('returns no regions for a fully static scene', () => {
    const cols = 24;
    const rows = 14;
    const grid = makeFlickerGrid(cols, rows, 96, 30, new Set());
    const result = detectScreens(grid, { ...DEFAULT_DETECTION_OPTIONS, fs: 30 });
    expect(result.regions.length).toBe(0);
  });

  it('score grid values stay within [0,1]', () => {
    const cols = 16;
    const rows = 10;
    const flicker = new Set<number>([20, 21, 36, 37]);
    const grid = makeFlickerGrid(cols, rows, 96, 30, flicker);
    const scores = scoreCells(grid, { ...DEFAULT_DETECTION_OPTIONS, fs: 30 });
    for (const s of scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });
});
