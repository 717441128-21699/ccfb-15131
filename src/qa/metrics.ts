/**
 * Quality-assurance metrics.
 *
 * Every metric is pure TypeScript on 8-bit RGBA frame buffers so the same
 * code runs in the browser QA harness and under vitest (Node) against
 * precomputed fixtures.
 *
 * Contract from the product spec:
 *   - text contrast of the processed board must not be lower than original
 *   - no more than 0.5% of pixels outside the screen may change
 *   - 1080p per-frame processing within 20 ms (measured separately on GPU)
 */

export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export function lumaAt(frame: RgbaFrame, x: number, y: number): number {
  const i = (y * frame.width + x) * 4;
  return (
    0.2126 * frame.data[i]! +
    0.7152 * frame.data[i + 1]! +
    0.0722 * frame.data[i + 2]!
  );
}

/**
 * Fraction of pixels outside the screen mask whose luma changed by more
 * than one 8-bit step. Feather pixels are counted as "inside".
 */
export function outsideChangedFraction(
  original: RgbaFrame,
  processed: RgbaFrame,
  screenMask: Uint8Array,
): number {
  let changed = 0;
  let total = 0;
  const n = original.width * original.height;
  for (let p = 0; p < n; p++) {
    if (screenMask[p]) continue;
    total++;
    const dl = Math.abs(
      lumaAt(original, p % original.width, (p / original.width) | 0) -
      lumaAt(processed, p % processed.width, (p / processed.width) | 0),
    );
    if (dl > 1.0) changed++;
  }
  return total ? changed / total : 0;
}

/**
 * RMS local contrast inside a mask, measured as the RMS deviation from a
 * box-filtered local mean (same window as the GPU guard).
 */
export function rmsContrast(
  frame: RgbaFrame,
  mask: Uint8Array,
  radius: number,
): number {
  const { width, height, data } = frame;
  const luma = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++) {
    luma[p] = 0.2126 * data[p * 4]! + 0.7152 * data[p * 4 + 1]! + 0.0722 * data[p * 4 + 2]!;
  }
  // Integral image for O(1) window means.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += luma[y * width + x]!;
      integral[(y + 1) * (width + 1) + x + 1] =
        integral[y * (width + 1) + x + 1]! + rowSum;
    }
  }
  let acc = 0;
  let count = 0;
  for (let p = 0; p < width * height; p++) {
    if (!mask[p]) continue;
    const x = p % width;
    const y = (p / width) | 0;
    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(width - 1, x + radius);
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const sum =
      integral[(y1 + 1) * (width + 1) + x1 + 1]! -
      integral[y0 * (width + 1) + x1 + 1]! -
      integral[(y1 + 1) * (width + 1) + x0]! +
      integral[y0 * (width + 1) + x0]!;
    const localMean = sum / area;
    const d = luma[p]! - localMean;
    acc += d * d;
    count++;
  }
  return count ? Math.sqrt(acc / count) : 0;
}

/** Processed/original RMS contrast ratio; >= 1 satisfies the contract. */
export function textContrastRatio(
  original: RgbaFrame,
  processed: RgbaFrame,
  screenMask: Uint8Array,
  radius = 3,
): number {
  const c0 = rmsContrast(original, screenMask, radius);
  const c1 = rmsContrast(processed, screenMask, radius);
  return c0 > 1e-9 ? c1 / c0 : 1;
}

/**
 * Flicker attenuation in dB: 20*log10(original temporal RMS / processed).
 * The series is the mean luma inside the (unoccluded) screen per frame.
 */
export function flickerAttenuationDb(
  origSeries: ArrayLike<number>,
  procSeries: ArrayLike<number>,
): number {
  const a = temporalAcRms(origSeries);
  const b = temporalAcRms(procSeries);
  if (a < 1e-9) return 0;
  return 20 * Math.log10(a / Math.max(b, 1e-9));
}

function temporalAcRms(xs: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < xs.length; i++) m += xs[i]!;
  m /= xs.length;
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i]! - m;
    s += d * d;
  }
  return Math.sqrt(s / xs.length);
}

/**
 * Pixel-wise temporal flicker energy inside a mask.
 *
 * Each masked pixel's luma is tracked over time; the AC energy is summed
 * across pixels. Unlike a spatial-mean series this does not cancel out
 * rolling stripes, whose phases vary across rows.
 *
 * Pixels whose temporal standard deviation is below `activeSigma` (default
 * ~1 8-bit luma step) are treated as static texture and excluded, so the
 * abundant static ad lettering cannot dilute the measured flicker.
 * Inputs are parallel arrays of RgbaFrame over the same time samples.
 */
export function pixelwiseFlickerEnergy(
  frames: RgbaFrame[],
  screenMask: Uint8Array,
  activeSigma = 1.0,
  occlusionMasks?: Uint8Array[],
): number {
  if (frames.length < 2) return 0;
  const n = frames[0]!.width * frames[0]!.height;
  // Running mean + M2 per pixel (Welford), masked pixels only.
  const mean = new Float64Array(n);
  const m2 = new Float64Array(n);
  const count = new Uint16Array(n);
  frames.forEach((frame, fi) => {
    const d = frame.data;
    const occ = occlusionMasks?.[fi];
    for (let p = 0; p < n; p++) {
      if (!screenMask[p] || (occ && occ[p])) continue;
      const i = p * 4;
      const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      const k = ++count[p]!;
      const delta = l - mean[p]!;
      mean[p] = mean[p]! + delta / k;
      m2[p] = m2[p]! + delta * (l - mean[p]!);
    }
  });
  let energy = 0;
  let used = 0;
  for (let p = 0; p < n; p++) {
    if (!screenMask[p] || count[p]! < 2) continue;
    const variance = m2[p]! / (count[p]! - 1);
    if (Math.sqrt(variance) < activeSigma) continue; // static texture / quantization
    energy += variance;
    used++;
  }
  return used ? energy / used : 0;
}

/** Number of active (temporally varying) masked pixels, for diagnostics. */
export function activeFlickerPixelCount(
  frames: RgbaFrame[],
  screenMask: Uint8Array,
  activeSigma = 1.0,
  occlusionMasks?: Uint8Array[],
): number {
  if (frames.length < 2) return 0;
  const n = frames[0]!.width * frames[0]!.height;
  const mean = new Float64Array(n);
  const m2 = new Float64Array(n);
  const count = new Uint16Array(n);
  frames.forEach((frame, fi) => {
    const d = frame.data;
    const occ = occlusionMasks?.[fi];
    for (let p = 0; p < n; p++) {
      if (!screenMask[p] || (occ && occ[p])) continue;
      const i = p * 4;
      const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      const k = ++count[p]!;
      const delta = l - mean[p]!;
      mean[p] = mean[p]! + delta / k;
      m2[p] = m2[p]! + delta * (l - mean[p]!);
    }
  });
  let used = 0;
  for (let p = 0; p < n; p++) {
    if (!screenMask[p] || count[p]! < 2) continue;
    if (Math.sqrt(m2[p]! / (count[p]! - 1)) >= activeSigma) used++;
  }
  return used;
}

/** Attenuation in dB between two clips' pixel-wise flicker energy. */
export function flickerAttenuationDbPixelwise(
  origFrames: RgbaFrame[],
  procFrames: RgbaFrame[],
  screenMask: Uint8Array,
  activeSigma = 1.0,
  occlusionMasks?: Uint8Array[],
): number {
  const e0 = pixelwiseFlickerEnergy(origFrames, screenMask, activeSigma, occlusionMasks);
  const e1 = pixelwiseFlickerEnergy(procFrames, screenMask, activeSigma, occlusionMasks);
  if (e0 < 1e-9) return 0;
  // Energy is variance; 10*log10 gives power dB.
  return 10 * Math.log10(e0 / Math.max(e1, 1e-12));
}

/**
 * Mean absolute luma difference inside occluded areas. A correct pipeline
 * leaves occluded pixels untouched, so this must be ~0.
 */
export function occlusionLeak(
  original: RgbaFrame,
  processed: RgbaFrame,
  occlusionMask: Uint8Array,
): number {
  let sum = 0;
  let n = 0;
  const total = original.width * original.height;
  for (let p = 0; p < total; p++) {
    if (!occlusionMask[p]) continue;
    const i = p * 4;
    sum +=
      Math.abs(original.data[i]! - processed.data[i]!) +
      Math.abs(original.data[i + 1]! - processed.data[i + 1]!) +
      Math.abs(original.data[i + 2]! - processed.data[i + 2]!);
    n += 3;
  }
  return n ? sum / n : 0;
}

export interface QaReport {
  outsideChangedFraction: number;
  textContrastRatio: number;
  flickerAttenuationDb: number;
  occlusionLeak: number;
  meanGpuMs: number;
  p95GpuMs: number;
  meetsOutsideBudget: boolean;
  meetsContrast: boolean;
  meetsFrameBudget: boolean;
}

export function summarizeQa(input: {
  outsideChangedFraction: number;
  textContrastRatio: number;
  flickerAttenuationDb: number;
  occlusionLeak: number;
  gpuMsSamples: number[];
}): QaReport {
  const sorted = input.gpuMsSamples.slice().sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0;
  return {
    outsideChangedFraction: input.outsideChangedFraction,
    textContrastRatio: input.textContrastRatio,
    flickerAttenuationDb: input.flickerAttenuationDb,
    occlusionLeak: input.occlusionLeak,
    meanGpuMs: mean,
    p95GpuMs: p95,
    meetsOutsideBudget: input.outsideChangedFraction <= 0.005,
    meetsContrast: input.textContrastRatio >= 1,
    meetsFrameBudget: p95 <= 20,
  };
}
