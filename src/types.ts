/**
 * Shared type definitions for the LED-screen restoration pipeline.
 */

/** A convex-ish polygon in normalized [0,1] image coordinates (x right, y down). */
export interface Quad {
  points: [number, number][];
}

/** A polygon in absolute pixel coordinates. */
export interface PixelPolygon {
  points: [number, number][];
}

/** Temporal modulation parameters of one screen region. */
export interface BeatModel {
  /** Flicker frequency in Hz (cycles per second). */
  frequencyHz: number;
  /** Period in seconds = 1 / frequencyHz. */
  periodSec: number;
  /** Temporal phase in radians so that alpha(t) = 1 + amp * sin(2*pi*f*t + phi). */
  phaseRad: number;
  /** Flicker amplitude (fraction of mean), estimated via curve fitting. */
  amplitude: number;
  /** Rolling-band spatial frequency: cycles per screen-height. */
  spatialCyclesPerHeight: number;
  /** Rolling-band phase slope: radians of phase per source-row of the screen. */
  rowPhaseSlope: number;
  /** Phase at row 0 in radians. */
  rowPhaseOffset: number;
  /** Flicker amplitude measured from per-row fits (stripe component). */
  stripeAmplitude: number;
  /** Fit quality in [0,1] (1 = perfect sinusoidal fit). */
  confidence: number;
}

/** A screen region with per-frame tracking state. */
export interface ScreenRegion {
  id: string;
  /** Polygon in the *reference* (detection) frame, normalized coords. */
  basePolygon: Quad;
  /** Per-frame 2D translation (pixels at full frame resolution). */
  translation: number[];
  /** Soft feather width in pixels for the mask. */
  featherPx: number;
  /** Per-region beat model. */
  beat: BeatModel | null;
}

/** Per-frame analysis result shared with the GPU pass. */
export interface FrameAnalysis {
  frameIndex: number;
  timeSec: number;
  /** Per-region: temporal gain alpha at this frame. */
  alpha: number[];
  /** Per-region: row-phase info packed for the shader (slope, spatial offset, temporal phase, amplitude). */
  stripe: { slope: number; offset: number; phase: number; amplitude: number }[];
  /** Per-region: current polygon in absolute frame pixels. */
  polygons: PixelPolygon[];
  /** Fraction of the screen region currently occluded [0,1]. */
  occlusion: number[];
  /** True when the frame was skipped by the estimator and parameters were held. */
  held: boolean;
}

/** One entry of the low-resolution temporal statistics grid. */
export interface GridCellStats {
  mean: number;
  variance: number;
  /** Temporal flicker energy (variance of the frame-to-frame mean). */
  flickerEnergy: number;
  /** Dominant temporal frequency in Hz, 0 if undefined. */
  dominantHz: number;
}

/** Result of the automatic screen detector. */
export interface DetectionResult {
  regions: ScreenRegion[];
  /** Probability map at analysis-grid resolution, values in [0,1]. */
  scoreGrid: Float32Array;
  gridCols: number;
  gridRows: number;
}

/** Quality metrics measured on a processed clip. */
export interface QualityMetrics {
  /** Flicker attenuation in dB on the screen (positive = reduced). */
  flickerAttenuationDb: number;
  /** RMS contrast of screen ad text, processed vs original (ratio, >=1 required). */
  textContrastRatio: number;
  /** Fraction of pixels outside the screen mask whose value changed beyond 1 luma step. */
  outsideChangedFraction: number;
  /** Mean absolute luma error inside occluded areas (should be ~0). */
  occlusionLeak: number;
}

/** Performance measurement for one processed frame. */
export interface PerfSample {
  frameIndex: number;
  /** GPU-only time in milliseconds. */
  gpuMs: number;
  /** End-to-end (analysis amortized + GPU) in milliseconds. */
  totalMs: number;
}

export interface AppSettings {
  analysisGridCols: number;
  analysisGridRows: number;
  featherPx: number;
  contrastGuardRadius: number;
  contrastGuardEpsilon: number;
  compensationStrength: number;
  holdFramesOnOcclusion: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  analysisGridCols: 96,
  analysisGridRows: 54,
  featherPx: 2.5,
  contrastGuardRadius: 3,
  contrastGuardEpsilon: 1 / 255,
  compensationStrength: 1,
  holdFramesOnOcclusion: 3,
};
