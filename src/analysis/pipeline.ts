/**
 * End-to-end CPU analysis pipeline.
 *
 * Frames arrive as downsampled RGB/luma grids. The pipeline owns the
 * temporal ring buffer, automatic detection (or manual calibration),
 * per-frame tracking, beat/stripe estimation with occlusion holds, and
 * produces the parameter tables the GPU compensation pass consumes.
 */

import { TemporalGrid, type GridFrame } from './frameBuffer';
import { detectScreens, DEFAULT_DETECTION_OPTIONS, type DetectionOptions } from './screenDetector';
import { ScreenTracker, DEFAULT_TRACK_OPTIONS, type TrackOptions } from './tracker';
import { estimateBeat, DEFAULT_BEAT_OPTIONS, type BeatEstimatorOptions, predictAlpha } from './beatEstimator';
import { OcclusionDetector, DEFAULT_OCCLUSION_OPTIONS, centerAlpha, type OcclusionOptions } from './occlusion';
import { quadToFlat, translateQuad, quadToPixels } from './geometry';
import { TAU, clamp } from './mathUtils';
import type { AppSettings, FrameAnalysis, PixelPolygon, ScreenRegion } from '../types';

export interface PipelineOptions {
  detection: DetectionOptions;
  track: TrackOptions;
  beat: BeatEstimatorOptions;
  occlusion: OcclusionOptions;
  settings: AppSettings;
}

export function defaultPipelineOptions(fps: number, settings: AppSettings): PipelineOptions {
  return {
    detection: { ...DEFAULT_DETECTION_OPTIONS, fs: fps },
    track: DEFAULT_TRACK_OPTIONS,
    beat: { ...DEFAULT_BEAT_OPTIONS, fs: fps },
    occlusion: DEFAULT_OCCLUSION_OPTIONS,
    settings,
  };
}

interface StoredFrameParams {
  alpha: number;
  slope: number;
  offset: number;
  /** Temporal beat phase in radians (constant per region until a refit). */
  phase: number;
  frequencyHz: number;
  amplitude: number;
  dxPx: number;
  dyPx: number;
  occlusionFraction: number;
  held: boolean;
}

export interface PipelineStatus {
  phase: 'collecting' | 'detected' | 'tracking';
  framesCollected: number;
  regionCount: number;
  occlusionFractions: number[];
}

export class AnalysisPipeline {
  readonly cols: number;
  readonly rows: number;
  readonly frameW: number;
  readonly frameH: number;
  readonly fps: number;
  readonly opts: PipelineOptions;
  readonly grid: TemporalGrid;

  regions: ScreenRegion[] = [];
  private tracker: ScreenTracker | null = null;
  private occluders: OcclusionDetector[] = [];
  private records: StoredFrameParams[][] = [];
  private frameTimes: number[] = [];
  private frameIndices: number[] = [];
  private holdCounter: number[] = [];
  private currentOcclusionGrid: Float32Array;
  status: PipelineStatus;
  onStatusChange: ((s: PipelineStatus) => void) | null = null;

  constructor(
    cols: number,
    rows: number,
    frameW: number,
    frameH: number,
    fps: number,
    opts: PipelineOptions,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.frameW = frameW;
    this.frameH = frameH;
    this.fps = fps;
    this.opts = opts;
    this.grid = new TemporalGrid(cols, rows, 512);
    this.currentOcclusionGrid = new Float32Array(cols * rows);
    this.status = { phase: 'collecting', framesCollected: 0, regionCount: 0, occlusionFractions: [] };
  }

  private emit(): void {
    this.onStatusChange?.(this.status);
  }

  /** Frames that must be buffered before detection can run. */
  get detectionReadyAt(): number {
    return Math.max(48, Math.ceil(this.fps * 1.5));
  }

  /** Run auto-detection now (also invoked automatically once enough frames exist). */
  runDetection(): void {
    const { regions } = detectScreens(this.grid, this.opts.detection);
    if (!regions.length) return;
    for (const r of regions) r.featherPx = this.opts.settings.featherPx;
    this.regions = regions;
    this.attachRegions();
    this.status = { ...this.status, phase: 'detected', regionCount: regions.length };
    this.emit();
  }

  /** Replace regions with manual calibration polygons (normalized coords). */
  setManualRegions(polygons: number[][]): void {
    this.regions = polygons.map((flat, i): ScreenRegion => ({
      id: `manual-${i}`,
      basePolygon: {
        points: flat.reduce<[number, number][]>((acc, _, k) =>
          k % 2 === 0 ? [...acc, [flat[k]!, flat[k + 1]!]] : acc, []),
      },
      translation: [],
      featherPx: this.opts.settings.featherPx,
      beat: null,
    }));
    this.attachRegions();
    this.status = { ...this.status, phase: 'detected', regionCount: this.regions.length };
    this.emit();
  }

  private attachRegions(): void {
    const ref = this.grid.latest();
    if (!ref) return;
    this.tracker = new ScreenTracker(this.opts.track);
    this.tracker.init(this.regions, ref, this.cols, this.rows);
    this.occluders = this.regions.map(
      (r) => new OcclusionDetector(quadToFlat(r.basePolygon), this.cols, this.rows, this.opts.occlusion),
    );
    this.holdCounter = this.regions.map(() => 0);
    // Re-estimate beats from the buffered history.
    const frames = this.grid.frames();
    this.records = frames.map(() => this.regions.map(() => ({
      alpha: 1, slope: 0, offset: 0, phase: 0, frequencyHz: 0, amplitude: 0,
      dxPx: 0, dyPx: 0, occlusionFraction: 0, held: false,
    })));
    this.frameTimes = frames.map((f) => f.timeSec);
    this.frameIndices = frames.map((f) => f.frameIndex);
    this.refitAllBeats(frames);
    this.status = { ...this.status, phase: 'tracking' };
  }

  /** Re-estimate every region's beat from the whole buffered history. */
  private refitAllBeats(frames: GridFrame[]): void {
    for (let ri = 0; ri < this.regions.length; ri++) {
      const region = this.regions[ri]!;
      const displacements = frames.map((_, fi): [number, number] => {
        const rec = this.records[fi]![ri]!;
        return [
          (rec.dxPx / this.frameW) * this.cols,
          (rec.dyPx / this.frameH) * this.rows,
        ];
      });
      const beat = estimateBeat(
        region, frames, displacements, this.cols, this.rows, this.opts.beat,
        this.frameWeights(ri, frames.length, 0),
      );
      if (beat) region.beat = beat;
      for (let fi = 0; fi < frames.length; fi++) {
        const rec = this.records[fi]![ri]!;
        if (region.beat) {
          rec.alpha = predictAlpha(region.beat, frames[fi]!.timeSec);
          rec.slope = region.beat.rowPhaseSlope;
          rec.offset = region.beat.rowPhaseOffset;
          rec.phase = region.beat.phaseRad;
          rec.frequencyHz = region.beat.frequencyHz;
          rec.amplitude = region.beat.amplitude;
        }
      }
    }
  }

  /** Ingest one downsampled frame and advance the whole analysis. */
  ingest(frame: GridFrame): void {
    this.grid.push(frame);
    this.status = { ...this.status, framesCollected: this.grid.length };
    if (this.regions.length === 0) {
      if (this.grid.length >= this.detectionReadyAt) this.runDetection();
      this.emit();
      return;
    }
    const displacementPx = this.tracker!.update(frame, this.cols, this.rows, this.frameW, this.frameH);
    this.currentOcclusionGrid.fill(0);
    const row: StoredFrameParams[] = this.regions.map((region, ri) => {
      const [dxPx, dyPx] = displacementPx[ri]!;
      const beat = region.beat;
      const alpha0 = beat ? centerAlpha(beat, frame.timeSec) : 1;
      const occ = this.occluders[ri]!.evaluate(frame, beat, alpha0, this.currentOcclusionGrid);
      if (occ.hold) {
        this.holdCounter[ri] = this.opts.settings.holdFramesOnOcclusion;
      } else if (this.holdCounter[ri]! > 0) {
        this.holdCounter[ri] = this.holdCounter[ri]! - 1;
      }
      const held = this.holdCounter[ri]! > 0;
      return {
        alpha: beat ? alpha0 : 1,
        slope: beat?.rowPhaseSlope ?? 0,
        offset: beat?.rowPhaseOffset ?? 0,
        phase: beat?.phaseRad ?? 0,
        frequencyHz: beat?.frequencyHz ?? 0,
        amplitude: beat?.amplitude ?? 0,
        dxPx,
        dyPx,
        occlusionFraction: occ.fraction,
        held,
      };
    });
    this.records.push(row);
    this.frameTimes.push(frame.timeSec);
    this.frameIndices.push(frame.frameIndex);
    if (this.records.length > this.grid.capacity) {
      this.records.shift();
      this.frameTimes.shift();
      this.frameIndices.shift();
    }
    // Periodic beat refit on clean recent frames (rolling window).
    if (frame.frameIndex % 12 === 0) this.refitRecent();
    this.status = {
      ...this.status,
      phase: 'tracking',
      occlusionFractions: row.map((r) => r.occlusionFraction),
    };
    this.emit();
  }

  /** Per-frame fit weights for a region: 0 when occluded/held, 1 otherwise. */
  private frameWeights(regionIndex: number, count: number, base: number): Float32Array {
    const w = new Float32Array(count).fill(1);
    for (let k = 0; k < count; k++) {
      const rec = this.records[base + k]?.[regionIndex];
      if (!rec) continue;
      if (rec.held || rec.occlusionFraction >= this.opts.occlusion.holdFraction) w[k] = 0;
    }
    return w;
  }

  private refitRecent(): void {
    const frames = this.grid.frames();
    const windowSize = Math.min(frames.length, Math.max(96, this.fps * 3));
    const recent = frames.slice(frames.length - windowSize);
    // Map each recent frame's index to its record row via frameIndices,
    // which stays aligned with records even though the grid starts earlier.
    const recordPos = new Map<number, number>();
    for (let k = 0; k < this.frameIndices.length; k++) {
      recordPos.set(this.frameIndices[k]!, k);
    }
    for (let ri = 0; ri < this.regions.length; ri++) {
      const region = this.regions[ri]!;
      const displacements: Array<[number, number]> = [];
      const weights = new Float32Array(recent.length).fill(1);
      let valid = 0;
      recent.forEach((gf, k) => {
        const pos = recordPos.get(gf.frameIndex);
        const rec = pos === undefined ? undefined : this.records[pos]?.[ri];
        if (rec) {
          displacements.push([
            (rec.dxPx / this.frameW) * this.cols,
            (rec.dyPx / this.frameH) * this.rows,
          ]);
          if (rec.held || rec.occlusionFraction >= this.opts.occlusion.holdFraction) weights[k] = 0;
          else valid++;
        } else {
          displacements.push([0, 0]);
        }
      });
      if (valid < 16) continue;
      const beat = estimateBeat(
        region, recent, displacements, this.cols, this.rows, this.opts.beat, weights,
      );
      if (beat) {
        region.beat = beat;
        recent.forEach((gf) => {
          const pos = recordPos.get(gf.frameIndex);
          if (pos === undefined) return;
          const rec = this.records[pos]![ri]!;
          rec.alpha = predictAlpha(beat, gf.timeSec);
          rec.slope = beat.rowPhaseSlope;
          rec.offset = beat.rowPhaseOffset;
          rec.phase = beat.phaseRad;
          rec.frequencyHz = beat.frequencyHz;
          rec.amplitude = beat.amplitude;
        });
      }
    }
  }

  /** Full per-frame parameter set for the GPU pass at a given frame. */
  getFrameAnalysis(frameIndex: number): FrameAnalysis | null {
    const pos = this.frameIndices.indexOf(frameIndex);
    if (pos < 0) return null;
    const row = this.records[pos]!;
    const timeSec = this.frameTimes[pos]!;
    const alpha: number[] = [];
    const stripe: FrameAnalysis['stripe'] = [];
    const polygons: PixelPolygon[] = [];
    const occlusion: number[] = [];
    for (let ri = 0; ri < this.regions.length; ri++) {
      const rec = row[ri]!;
      const region = this.regions[ri]!;
      alpha.push(rec.alpha);
      stripe.push({
        slope: rec.slope,
        offset: rec.offset,
        phase: rec.phase,
        amplitude: rec.amplitude,
      });
      const moved = translateQuad(region.basePolygon, rec.dxPx, rec.dyPx, this.frameW, this.frameH);
      polygons.push(quadToPixels(moved, this.frameW, this.frameH));
      occlusion.push(rec.occlusionFraction);
    }
    return {
      frameIndex,
      timeSec,
      alpha,
      stripe,
      polygons,
      occlusion,
      held: row.some((r) => r.held),
    };
  }

  /** Latest occlusion grid (analysis resolution), uploaded as a texture. */
  get occlusionGrid(): Float32Array {
    return this.currentOcclusionGrid;
  }

  get totalFrames(): number {
    return this.records.length;
  }

  /** Predicted compensation gain at an arbitrary (t, fractional row v). */
  predictedGain(regionIndex: number, timeSec: number, v: number): number {
    const beat = this.regions[regionIndex]?.beat;
    if (!beat) return 1;
    return 1 / clamp(1 + beat.amplitude * Math.sin(TAU * beat.frequencyHz * timeSec + beat.phaseRad + beat.rowPhaseSlope * v), 0.25, 4);
  }
}
