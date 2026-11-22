import { describe, it, expect } from 'vitest';
import {
  rasterizeCells,
  quadToFlat,
  quadToPixels,
  translateQuad,
  polygonBBox,
  polygonCentroid,
  polygonSdf,
} from '../src/analysis/geometry';

describe('rasterizeCells', () => {
  it('covers all cells inside a normalized rectangle', () => {
    const poly = [0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75];
    const cells = rasterizeCells(poly, 20, 20);
    expect(cells.length).toBeGreaterThan(50);
    for (const c of cells) {
      const x = (c % 20) + 0.5;
      const y = ((c / 20) | 0) + 0.5;
      expect(x).toBeGreaterThanOrEqual(5);
      expect(x).toBeLessThanOrEqual(15);
      expect(y).toBeGreaterThanOrEqual(5);
      expect(y).toBeLessThanOrEqual(15);
    }
  });
});

describe('translateQuad / quadToPixels', () => {
  it('moves a polygon by pixel displacement and scales to frame size', () => {
    const quad = { points: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] as [number, number][] };
    const moved = translateQuad(quad, 192, 108, 1920, 1080);
    expect(moved.points[0]![0]).toBeCloseTo(0.1, 6);
    expect(moved.points[0]![1]).toBeCloseTo(0.1, 6);
    const px = quadToPixels(moved, 1920, 1080);
    expect(px.points[0]![0]).toBeCloseTo(192, 6);
    expect(px.points[0]![1]).toBeCloseTo(108, 6);
    expect(quadToFlat(quad).length).toBe(8);
  });
});

describe('polygon helpers', () => {
  it('computes bbox and centroid', () => {
    const poly = [10, 20, 50, 20, 50, 60, 10, 60];
    const bb = polygonBBox(poly);
    expect(bb).toEqual({ minX: 10, minY: 20, maxX: 50, maxY: 60 });
    const [cx, cy] = polygonCentroid(poly);
    expect(cx).toBeCloseTo(30, 6);
    expect(cy).toBeCloseTo(40, 6);
  });

  it('SDF is negative inside and positive outside', () => {
    const poly = [0, 0, 100, 0, 100, 100, 0, 100];
    expect(polygonSdf(50, 50, poly)).toBeLessThan(0);
    expect(polygonSdf(150, 50, poly)).toBeGreaterThan(0);
    expect(polygonSdf(100, 50, poly)).toBeCloseTo(0, 4);
  });
});
