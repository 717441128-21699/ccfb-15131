import { describe, it, expect } from 'vitest';
import { estimateBeat, predictAlpha, regionMeanSeries } from '../src/analysis/beatEstimator';
import { TemporalGrid, type GridFrame } from '../src/analysis/frameBuffer';
import { rasterizeCells } from '../src/analysis/geometry';
import type { ScreenRegion } from '../src/types';
import { TAU } from '../src/analysis/mathUtils';

const cols = 32;
const rows = 18;
const fps = 30;

function buildClip(frames: number, freqHz: number, amplitude: number, stripeCycles: number): {
  grid: TemporalGrid;
  region: ScreenRegion;
} {
  const region: ScreenRegion = {
    id: 'r0',
    basePolygon: {
      points: [
        [0.1, 0.45],
        [0.9, 0.45],
        [0.9, 0.75],
        [0.1, 0.75],
      ],
    },
    translation: [],
    featherPx: 2,
    beat: null,
  };
  const cells = rasterizeCells(region.basePolygon.points.flat(), cols, rows);
  const grid = new TemporalGrid(cols, rows, frames + 8);
  for (let f = 0; f < frames; f++) {
    const luma = new Float32Array(cols * rows);
    const rgb = new Float32Array(cols * rows * 3);
    for (let c = 0; c < cols * rows; c++) {
      let v = 0.25 + ((c * 13) % 20) / 200;
      if (cells.includes(c)) {
        const row = (c / cols) | 0;
        const vFrac = (row - 0.45 * rows) / (0.3 * rows);
        const spatial = TAU * stripeCycles * vFrac;
        v = 0.5 * (1 + amplitude * Math.sin(TAU * freqHz * (f / fps) + spatial));
      }
      luma[c] = v;
      rgb[c * 3] = v * 0.7;
      rgb[c * 3 + 1] = v * 0.9;
      rgb[c * 3 + 2] = v;
    }
    grid.push({ frameIndex: f, timeSec: f / fps, rgb, luma } as GridFrame);
  }
  return { grid, region };
}

describe('estimateBeat', () => {
  it('recovers flicker frequency, amplitude and phase from a synthetic board', () => {
    const freqHz = 6.5;
    const amp = 0.3;
    const { grid, region } = buildClip(192, freqHz, amp, 0);
    const frames = grid.frames();
    const displacements = frames.map(() => [0, 0] as [number, number]);
    const beat = estimateBeat(region, frames, displacements, cols, rows, {
      fs: fps,
      minFrequencyHz: 2,
      maxFrequencyHz: 30,
      minAmplitude: 0.02,
      minConfidence: 0.3,
    });
    expect(beat).not.toBeNull();
    expect(beat!.frequencyHz).toBeCloseTo(freqHz, 0);
    expect(beat!.amplitude).toBeCloseTo(amp, 1);
    expect(beat!.confidence).toBeGreaterThan(0.7);
  });

  it('estimates a non-zero spatial phase slope when rolling stripes exist', () => {
    const { grid, region } = buildClip(192, 7, 0.3, 1.5);
    const frames = grid.frames();
    const beat = estimateBeat(region, frames, frames.map(() => [0, 0] as [number, number]), cols, rows, {
      fs: fps,
      minFrequencyHz: 2,
      maxFrequencyHz: 30,
      minAmplitude: 0.02,
      minConfidence: 0.25,
    });
    expect(beat).not.toBeNull();
    // slopeV encodes 2*pi*stripeCycles across the board height.
    expect(Math.abs(beat!.rowPhaseSlope)).toBeGreaterThan(TAU * 0.5);
    expect(beat!.spatialCyclesPerHeight).toBeGreaterThan(0.5);
  });

  it('returns null below the confidence threshold', () => {
    const { grid, region } = buildClip(96, 7, 0.005, 0);
    const frames = grid.frames();
    const beat = estimateBeat(region, frames, frames.map(() => [0, 0] as [number, number]), cols, rows, {
      fs: fps,
      minFrequencyHz: 2,
      maxFrequencyHz: 30,
      minAmplitude: 0.02,
      minConfidence: 0.5,
    });
    expect(beat).toBeNull();
  });
});

describe('predictAlpha', () => {
  it('is periodic with the estimated frequency', () => {
    const beat = {
      frequencyHz: 5,
      periodSec: 0.2,
      phaseRad: 0.3,
      amplitude: 0.25,
      spatialCyclesPerHeight: 0,
      rowPhaseSlope: 0,
      rowPhaseOffset: 0,
      stripeAmplitude: 0.25,
      confidence: 1,
    };
    const a1 = predictAlpha(beat, 1.2, 0.5);
    const a2 = predictAlpha(beat, 1.2 + beat.periodSec, 0.5);
    expect(a1).toBeCloseTo(a2, 6);
  });

  it('varies across rows when a slope is present', () => {
    const beat = {
      frequencyHz: 5,
      periodSec: 0.2,
      phaseRad: 0,
      amplitude: 0.3,
      spatialCyclesPerHeight: 1,
      rowPhaseSlope: TAU,
      rowPhaseOffset: 0,
      stripeAmplitude: 0.3,
      confidence: 1,
    };
    // Centered model: theta = slope * (v - 0.5), slope = 2*pi.
    const top = predictAlpha(beat, 0, 0);        // v-0.5=-0.5 -> sin(-pi)=0
    const bottom = predictAlpha(beat, 0, 1);     // v-0.5=+0.5 -> sin(+pi)=0
    expect(top).toBeCloseTo(1, 6);
    expect(bottom).toBeCloseTo(1, 6);
    const quarter = predictAlpha(beat, 0, 0.25); // v-0.5=-0.25 -> sin(-pi/2)=-1
    expect(quarter).toBeCloseTo(0.7, 6);
    const center = predictAlpha(beat, 0, 0.5);   // spatial term vanishes at center
    expect(center).toBeCloseTo(1, 6);
  });
});

describe('regionMeanSeries', () => {
  it('follows the imposed oscillation', () => {
    const { grid, region } = buildClip(120, 6, 0.3, 0);
    const frames = grid.frames();
    const series = regionMeanSeries(region, frames, frames.map(() => [0, 0] as [number, number]), cols, rows);
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const min = Math.min(...series);
    const max = Math.max(...series);
    expect(mean).toBeGreaterThan(0.3);
    expect(max - min).toBeGreaterThan(0.2);
  });
});
