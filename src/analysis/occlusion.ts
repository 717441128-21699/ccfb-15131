/**
 * Occlusion detector for a tracked screen region.
 *
 * A player crossing in front of the board breaks the periodic flicker
 * signature. We keep a temporal reference (median RGB per cell, which
 * averages out the flicker cycles) and a robust per-cell noise scale.
 * Each frame the predicted luma is reference * alpha(t); cells whose
 * residual exceeds several robust sigmas AND whose colour moved away
 * from the reference are marked occluded.
 *
 * Output feeds both the parameter hold logic and a low-resolution
 * occlusion texture consumed by the compensation shader.
 */

import { TAU, clamp } from './mathUtils';
import { rasterizeCells } from './geometry';
import type { GridFrame } from './frameBuffer';
import type { BeatModel } from '../types';

export interface OcclusionOptions {
  /** Residual threshold in robust standard deviations. */
  zThreshold: number;
  /** Minimum colour distance (0..1) to count as occlusion. */
  minColorDistance: number;
  /** Hold beat parameters when more than this fraction is occluded. */
  holdFraction: number;
  /** EMA factor for reference refresh while clean. */
  referenceEma: number;
}

export const DEFAULT_OCCLUSION_OPTIONS: OcclusionOptions = {
  zThreshold: 3.5,
  minColorDistance: 0.09,
  holdFraction: 0.12,
  referenceEma: 0.02,
};

export class OcclusionDetector {
  readonly opts: OcclusionOptions;
  private cellIndices: number[];
  private cellRowV: Float32Array;
  private refRgb: Float32Array;
  private refLuma: Float32Array;
  private sigma: Float32Array;
  private initialized = false;
  private rowSpan: number;

  constructor(
    polygonNorm: number[],
    cols: number,
    _rows: number,
    opts: OcclusionOptions = DEFAULT_OCCLUSION_OPTIONS,
  ) {
    this.opts = opts;
    this.cellIndices = rasterizeCells(polygonNorm, cols, _rows);
    this.refRgb = new Float32Array(this.cellIndices.length * 3);
    this.refLuma = new Float32Array(this.cellIndices.length);
    this.sigma = new Float32Array(this.cellIndices.length).fill(0.02);
    // Fractional board row v in [0,1] for each tracked cell, so the rolling
    // stripe phase can be evaluated per cell instead of at the center row.
    let minRow = Infinity;
    let maxRow = -Infinity;
    for (const c of this.cellIndices) {
      const r = (c / cols) | 0;
      minRow = Math.min(minRow, r);
      maxRow = Math.max(maxRow, r);
    }
    this.rowSpan = Math.max(1, maxRow - minRow);
    this.cellRowV = new Float32Array(this.cellIndices.length);
    for (let i = 0; i < this.cellIndices.length; i++) {
      const r = (this.cellIndices[i]! / cols) | 0;
      this.cellRowV[i] = (r - minRow) / this.rowSpan;
    }
  }

  get cells(): number[] {
    return this.cellIndices;
  }

  /** Predicted gain for one cell given its fractional board row. */
  private cellGain(beat: BeatModel | null, alpha: number, timeSec: number, v: number): number {
    if (!beat) return clamp(alpha, 0.4, 2.5);
    const theta = TAU * beat.frequencyHz * timeSec + beat.phaseRad + beat.rowPhaseSlope * v;
    return clamp(1 + beat.amplitude * Math.sin(theta), 0.4, 2.5);
  }

  /**
   * Evaluate one frame. `alpha` is the beat-predicted center-row gain.
   * `occlusionGrid` is a full cols*rows Float32Array (0 = visible, 1 = occluded).
   */
  evaluate(
    frame: GridFrame,
    beat: BeatModel | null,
    alpha: number,
    occlusionGrid: Float32Array,
  ): { fraction: number; hold: boolean; cellMask: Uint8Array } {
    const mask = new Uint8Array(this.cellIndices.length);
    let occluded = 0;
    if (!this.initialized) {
      for (let i = 0; i < this.cellIndices.length; i++) {
        const c = this.cellIndices[i]!;
        this.refRgb[i * 3] = frame.rgb[c * 3]!;
        this.refRgb[i * 3 + 1] = frame.rgb[c * 3 + 1]!;
        this.refRgb[i * 3 + 2] = frame.rgb[c * 3 + 2]!;
        this.refLuma[i] = frame.luma[c]!;
      }
      this.initialized = true;
    }
    const residuals: number[] = [];
    for (let i = 0; i < this.cellIndices.length; i++) {
      const c = this.cellIndices[i]!;
      const r = frame.rgb[c * 3]!;
      const g = frame.rgb[c * 3 + 1]!;
      const b = frame.rgb[c * 3 + 2]!;
      const l = frame.luma[c]!;
      const gain = this.cellGain(beat, alpha, frame.timeSec, this.cellRowV[i]!);
      const predicted = this.refLuma[i]! * gain;
      const z = Math.abs(l - predicted) / Math.max(1e-3, this.sigma[i]!);
      const dr = r - this.refRgb[i * 3]!;
      const dg = g - this.refRgb[i * 3 + 1]!;
      const db = b - this.refRgb[i * 3 + 2]!;
      const colorDist = Math.hypot(dr, dg, db);
      const isOccluded = z > this.opts.zThreshold && colorDist > this.opts.minColorDistance;
      if (isOccluded) {
        mask[i] = 1;
        occluded++;
        occlusionGrid[c] = 1;
      } else {
        residuals.push(l - predicted);
      }
    }
    const fraction = occluded / this.cellIndices.length;
    if (fraction < this.opts.holdFraction) {
      // Clean frame: refresh reference and robust noise scale.
      const med = median(residuals);
      const mad = median(residuals.map((v) => Math.abs(v - med))) || 0.01;
      const robustSigma = 1.4826 * mad;
      const e = this.opts.referenceEma;
      for (let i = 0; i < this.cellIndices.length; i++) {
        if (mask[i]) continue;
        const c = this.cellIndices[i]!;
        const rIdx = i * 3;
        const cellGain = this.cellGain(beat, alpha, frame.timeSec, this.cellRowV[i]!);
        this.refRgb[rIdx] = this.refRgb[rIdx]! + (frame.rgb[c * 3]! / cellGain - this.refRgb[rIdx]!) * e;
        this.refRgb[rIdx + 1] = this.refRgb[rIdx + 1]! + (frame.rgb[c * 3 + 1]! / cellGain - this.refRgb[rIdx + 1]!) * e;
        this.refRgb[rIdx + 2] = this.refRgb[rIdx + 2]! + (frame.rgb[c * 3 + 2]! / cellGain - this.refRgb[rIdx + 2]!) * e;
        this.refLuma[i] = this.refLuma[i]! + (frame.luma[c]! / cellGain - this.refLuma[i]!) * e;
        this.sigma[i] = Math.max(0.004, this.sigma[i]! * (1 - e) + robustSigma * e);
      }
    }
    return { fraction, hold: fraction >= this.opts.holdFraction, cellMask: mask };
  }
}

/** Predicted beat gain at frame time for the region's center row. */
export function centerAlpha(beat: BeatModel, timeSec: number): number {
  return 1 + beat.amplitude * Math.sin(TAU * beat.frequencyHz * timeSec + beat.phaseRad);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) * 0.5;
}
