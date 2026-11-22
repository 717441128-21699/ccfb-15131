/**
 * Beat (temporal flicker) and rolling-stripe parameter estimation.
 *
 * For each tracked screen region we build:
 *   - a region-mean luma time series  -> flicker frequency, amplitude, phase
 *   - one series per covered grid row -> per-row phases, regressed linearly
 *     into a spatial phase slope, i.e. the rolling-band term.
 * All math is least-squares sinusoid fitting (see mathUtils.fitSinusoid).
 */

import { fitSinusoidWeighted, dominantFrequency, TAU, clamp, linearFit } from './mathUtils';
import { rasterizeCells, quadToFlat, polygonBBox } from './geometry';
import type { GridFrame } from './frameBuffer';
import type { BeatModel, ScreenRegion } from '../types';

export interface BeatEstimatorOptions {
  fs: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
  minAmplitude: number;
  minConfidence: number;
}

export const DEFAULT_BEAT_OPTIONS: BeatEstimatorOptions = {
  fs: 30,
  minFrequencyHz: 2,
  maxFrequencyHz: 240,
  minAmplitude: 0.015,
  minConfidence: 0.35,
};

/** Per-frame displacement of one region in grid cells. */
export type DisplacementCells = Array<[number, number]>;

export function regionMeanSeries(
  region: ScreenRegion,
  frames: GridFrame[],
  displacements: DisplacementCells,
  cols: number,
  rows: number,
): Float32Array {
  const baseCells = rasterizeCells(quadToFlat(region.basePolygon), cols, rows);
  const out = new Float32Array(frames.length);
  for (let f = 0; f < frames.length; f++) {
    const [dx, dy] = displacements[f] ?? [0, 0];
    let sum = 0;
    let n = 0;
    const luma = frames[f]!.luma;
    for (const cell of baseCells) {
      const x = (cell % cols) + dx;
      const y = ((cell / cols) | 0) + dy;
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) continue;
      sum += luma[yi * cols + xi]!;
      n++;
    }
    out[f] = n ? sum / n : 0;
  }
  return out;
}

/** Per-row mean luma series (rows in grid coordinates). */
export function rowSeries(
  region: ScreenRegion,
  frames: GridFrame[],
  displacements: DisplacementCells,
  cols: number,
  rows: number,
): { rowIndex: number; cells: number[]; series: Float32Array }[] {
  const baseCells = rasterizeCells(quadToFlat(region.basePolygon), cols, rows);
  const bbox = polygonBBox(quadToFlat(region.basePolygon).map((v, i) =>
    i % 2 === 0 ? v * cols : v * rows));
  const result: { rowIndex: number; cells: number[]; series: Float32Array }[] = [];
  for (let ry = Math.floor(bbox.minY); ry <= Math.ceil(bbox.maxY); ry++) {
    const rowCells = baseCells.filter((c) => ((c / cols) | 0) === ry);
    if (rowCells.length < 2) continue;
    const series = new Float32Array(frames.length);
    for (let f = 0; f < frames.length; f++) {
      const [dx, dy] = displacements[f] ?? [0, 0];
      let sum = 0;
      let n = 0;
      const luma = frames[f]!.luma;
      for (const cell of rowCells) {
        const xi = Math.round((cell % cols) + dx);
        const yi = Math.round(((cell / cols) | 0) + dy);
        if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) continue;
        sum += luma[yi * cols + xi]!;
        n++;
      }
      series[f] = n ? sum / n : 0;
    }
    result.push({ rowIndex: ry, cells: rowCells, series });
  }
  return result;
}

function unwrapPhase(p: number, prev: number): number {
  let d = p - prev;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return prev + d;
}

export function estimateBeat(
  region: ScreenRegion,
  frames: GridFrame[],
  displacements: DisplacementCells,
  cols: number,
  rows: number,
  opts: BeatEstimatorOptions,
  frameWeights?: ArrayLike<number>,
): BeatModel | null {
  if (frames.length < 16) return null;
  const t = frames.map((f) => f.timeSec);
  const w = frameWeights ?? frames.map(() => 1);

  // Rolling stripes cancel out in a whole-region spatial average, so the
  // temporal beat is estimated per covered row and then aggregated.
  const rowsData = rowSeries(region, frames, displacements, cols, rows);
  if (rowsData.length < 3) return null;

  // 1) Find a candidate frequency. Weight the spectral search by the same
  // per-frame validity so occluded frames do not create spurious peaks.
  let bestHz = 0;
  let bestRowMag = -1;
  const validCount = Array.from(w as ArrayLike<number>).reduce((a, x) => a + (x > 0 ? 1 : 0), 0);
  if (validCount < 16) return null;
  for (const rd of rowsData) {
    const masked = rd.series.map((v, i) => v * (w[i] ?? 0));
    const s = dominantFrequency(masked, opts.fs, opts.minFrequencyHz);
    if (s.hz >= opts.minFrequencyHz && s.hz <= opts.maxFrequencyHz && s.magnitude > bestRowMag) {
      bestRowMag = s.magnitude;
      bestHz = s.hz;
    }
  }
  if (bestHz <= 0) return null;
  const omega = TAU * bestHz;

  // 2) Fit every row at the shared frequency.
  interface RowFit {
    rowIndex: number;
    offset: number;
    amplitude: number;
    relAmplitude: number;
    phase: number;
    r2: number;
  }
  const rowFits: RowFit[] = [];
  let prevPhase = 0;
  let firstPhase: number | null = null;
  for (const rd of rowsData) {
    const rf = fitSinusoidWeighted(t, rd.series, omega, w);
    if (rf.r2 < opts.minConfidence * 0.6 || rf.offset <= 1e-6) continue;
    const phase: number = firstPhase === null ? rf.phaseRad : unwrapPhase(rf.phaseRad, prevPhase);
    prevPhase = phase;
    if (firstPhase === null) firstPhase = phase;
    rowFits.push({
      rowIndex: rd.rowIndex,
      offset: rf.offset,
      amplitude: rf.amplitude,
      relAmplitude: rf.amplitude / rf.offset,
      phase,
      r2: rf.r2,
    });
  }
  if (rowFits.length < 3) return null;

  // 3) Aggregate. Grid downsampling attenuates per-cell modulation, so use a
  // high percentile of the row amplitudes (rows least blurred by the box
  // average) rather than the median, which systematically under-reads depth.
  const relAmps = rowFits.map((r) => r.relAmplitude).sort((a, b) => a - b);
  const p90 = relAmps[Math.min(relAmps.length - 1, Math.floor(relAmps.length * 0.9))]!;
  const relAmplitude = clamp(p90, 0, 1.2);
  const meanR2 = rowFits.reduce((a, r) => a + r.r2, 0) / rowFits.length;
  if (relAmplitude < opts.minAmplitude || meanR2 < opts.minConfidence) return null;

  // 4) Spatial phase regression across rows -> rolling-stripe slope.
  //    Model per top-origin fractional row v in [0,1]:
  //      phase(v) = phaseCenter + slopeV * (v - 0.5)
  //    so that phaseRad (phaseCenter) is the phase at the board's middle row
  //    and the shader reproduces it exactly at vTop = 0.5.
  const xs = rowFits.map((r) => r.rowIndex);
  const phases = rowFits.map((r) => r.phase);
  const weights = rowFits.map((r) => r.r2);
  const lf = linearFit(xs, phases, weights);
  const normBBox = polygonBBox(
    quadToFlat(region.basePolygon).map((v, i) => (i % 2 === 0 ? v * cols : v * rows)),
  );
  const coveredGridRows = Math.max(1, normBBox.maxY - normBBox.minY);
  // lf.slope is radians per grid row; convert to radians per fractional v.
  const slopeV = lf.slope * coveredGridRows;
  const hasStripe = Math.abs(slopeV) > TAU * 0.25 && lf.r2 > 0.4;
  // Grid row at the vertical center of the board.
  const centerGridRow = (normBBox.minY + normBBox.maxY) * 0.5;
  // Phase at the center row from the regression line.
  const phaseCenter = lf.slope * centerGridRow + lf.offset;
  const rowPhaseOffset = lf.offset;
  const stripeAmplitude = relAmplitude;
  const confidence = hasStripe
    ? clamp(meanR2 * 0.7 + lf.r2 * 0.3, 0, 1)
    : clamp(meanR2, 0, 1);

  return {
    frequencyHz: bestHz,
    periodSec: 1 / bestHz,
    phaseRad: phaseCenter,
    amplitude: relAmplitude,
    spatialCyclesPerHeight: slopeV / TAU,
    rowPhaseSlope: slopeV,
    rowPhaseOffset,
    confidence,
    stripeAmplitude,
  };
}

/**
 * Predicted observed gain alpha(t, v) for a beat model.
 * v is the top-origin fractional row inside the screen (0 top, 1 bottom).
 * alpha = 1 + A * sin(2*pi*f*t + phaseCenter + slopeV*(v - 0.5)).
 * This must match the composite shader exactly.
 */
export function predictAlpha(beat: BeatModel, timeSec: number, v = 0.5): number {
  const theta = TAU * beat.frequencyHz * timeSec + beat.phaseRad + beat.rowPhaseSlope * (v - 0.5);
  return 1 + beat.amplitude * Math.sin(theta);
}
