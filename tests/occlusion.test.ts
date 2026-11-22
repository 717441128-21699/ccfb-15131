import { describe, it, expect } from 'vitest';
import { OcclusionDetector, DEFAULT_OCCLUSION_OPTIONS } from '../src/analysis/occlusion';
import type { GridFrame } from '../src/analysis/frameBuffer';
import type { BeatModel } from '../src/types';
import { TAU } from '../src/analysis/mathUtils';

const cols = 20;
const rows = 12;
const fps = 30;

function frame(index: number, lumaAt: (cell: number) => number, rgbAt?: (cell: number) => [number, number, number]): GridFrame {
  const luma = new Float32Array(cols * rows);
  const rgb = new Float32Array(cols * rows * 3);
  for (let c = 0; c < cols * rows; c++) {
    const v = lumaAt(c);
    luma[c] = v;
    const [r, g, b] = rgbAt?.(c) ?? [v, v, v];    rgb[c * 3] = r;
    rgb[c * 3 + 1] = g;
    rgb[c * 3 + 2] = b;
  }
  return { frameIndex: index, timeSec: index / fps, rgb, luma };
}

const beat: BeatModel = {
  frequencyHz: 6,
  periodSec: 1 / 6,
  phaseRad: 0,
  amplitude: 0.25,
  spatialCyclesPerHeight: 0,
  rowPhaseSlope: 0,
  rowPhaseOffset: 0,
  stripeAmplitude: 0.25,
  confidence: 0.95,
};

describe('OcclusionDetector', () => {
  it('reports no occlusion while the board follows its beat', () => {
    const poly = [0.1, 0.4, 0.9, 0.4, 0.9, 0.7, 0.1, 0.7];
    const det = new OcclusionDetector(poly, cols, rows, DEFAULT_OCCLUSION_OPTIONS);
    const grid = new Float32Array(cols * rows);
    let maxFraction = 0;
    for (let f = 0; f < 40; f++) {
      const alpha = 1 + beat.amplitude * Math.sin(TAU * beat.frequencyHz * (f / fps));
      const fr = frame(f, () => 0.5 * alpha);
      const res = det.evaluate(fr, beat, alpha, grid);
      maxFraction = Math.max(maxFraction, res.fraction);
      grid.fill(0);
    }
    expect(maxFraction).toBeLessThan(0.1);
  });

  it('flags a dark colored object crossing the board as occluded', () => {
    const poly = [0.1, 0.4, 0.9, 0.4, 0.9, 0.7, 0.1, 0.7];
    const det = new OcclusionDetector(poly, cols, rows);
    // Prime with clean beat frames.
    for (let f = 0; f < 20; f++) {
      const alpha = 1 + beat.amplitude * Math.sin(TAU * beat.frequencyHz * (f / fps));
      det.evaluate(frame(f, () => 0.5 * alpha), beat, alpha, new Float32Array(cols * rows));
    }
    // Occluder: red shirt, bright luma but very different color.
    const f = 20;
    const alpha = 1 + beat.amplitude * Math.sin(TAU * beat.frequencyHz * (f / fps));
    const occGrid = new Float32Array(cols * rows);
    // Occluder: red shirt. Indices 120..134 sit inside the board polygon
    // (grid row 6, x columns 0..14 — polygon spans x=2..17, y=5..8).
    const res = det.evaluate(
      frame(
        f,
        (c) => (c >= 120 && c < 135 ? 0.25 : 0.5 * alpha),
        (c) => (c >= 120 && c < 135 ? [0.75, 0.1, 0.08] : [0.5 * alpha, 0.5 * alpha, 0.5 * alpha]),
      ),
      beat,
      alpha,
      occGrid,
    );
    expect(res.hold).toBe(true);
    expect(res.fraction).toBeGreaterThan(0.15);
    let marked = 0;
    for (const v of occGrid) if (v > 0) marked++;
    expect(marked).toBeGreaterThan(0);
  });

  it('static non-board area never gets an occlusion mark', () => {
    const poly = [0.1, 0.4, 0.4, 0.4, 0.4, 0.7, 0.1, 0.7];
    const det = new OcclusionDetector(poly, cols, rows);
    const occGrid = new Float32Array(cols * rows);
    det.evaluate(frame(0, () => 0.4), beat, 1, occGrid);
    const total = occGrid.reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });
});
