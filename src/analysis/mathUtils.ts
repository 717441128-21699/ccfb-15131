/**
 * Small numeric helpers used across the analysis layer.
 * Pure functions only — everything here is unit-tested in Node.
 */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i] as number;
  return xs.length ? s / xs.length : 0;
}

export function rms(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] as number) * (xs[i] as number);
  return xs.length ? Math.sqrt(s / xs.length) : 0;
}

/** Population standard deviation. */
export function stdev(xs: ArrayLike<number>): number {
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = (xs[i] as number) - m;
    s += d * d;
  }
  return xs.length ? Math.sqrt(s / xs.length) : 0;
}

/**
 * Iterative radix-2 Cooley–Tukey FFT for complex interleaved input.
 * Length must be a power of two; output replaces the input arrays.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      const ti = im[i] as number;
      re[i] = re[j] as number;
      im[i] = im[j] as number;
      re[j] = tr;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-TAU) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const xr = (re[b] as number) * curR - (im[b] as number) * curI;
        const xi = (re[b] as number) * curI + (im[b] as number) * curR;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
      }
    }
  }
}

/** Hann window. */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((TAU * i) / (n - 1)));
  return w;
}

/**
 * Dominant non-DC spectral bin of a real signal, with parabolic
 * sub-bin interpolation. Returns frequency in Hz given sample rate `fs`.
 * Frequencies below `minHz` are ignored (camera drift / window leakage).
 */
export function dominantFrequency(
  signal: ArrayLike<number>,
  fs: number,
  minHz = 0,
): {
  hz: number;
  phaseRad: number;
  magnitude: number;
} {
  const n = signal.length;
  let fftLen = 1;
  while (fftLen < n) fftLen <<= 1;
  // AC-couple first: a large DC offset would otherwise leak through the
  // Hann window sidelobes into the lowest bins and dominate the spectrum.
  let meanVal = 0;
  for (let i = 0; i < n; i++) meanVal += signal[i] as number;
  meanVal /= n;
  const re = new Float64Array(fftLen);
  const im = new Float64Array(fftLen);
  const win = hannWindow(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    re[i] = ((signal[i] as number) - meanVal) * (win[i] as number);
    wsum += win[i] as number;
  }
  const norm = wsum || 1;
  for (let i = 0; i < n; i++) re[i] = (re[i] as number) / norm * 2;
  fft(re, im);
  let best = 0;
  let bestMag = -1;
  const maxBin = Math.floor(fftLen / 2);
  // Enforce the minimum frequency as a starting bin; this rejects slow
  // exposure drift and Hann-window DC leakage alongside the lowest-bin skip.
  const minBin = Math.max(1, Math.ceil((minHz * fftLen) / fs));
  const mags: number[] = new Array(maxBin).fill(0);
  for (let k = minBin; k < maxBin; k++) {
    const mag = Math.hypot(re[k] as number, im[k] as number);
    mags[k] = mag;
    if (mag > bestMag) {
      bestMag = mag;
      best = k;
    }
  }
  // Reject noise-only / flat signals: a real tone stands well above the
  // median spectral floor and clears an absolute amplitude threshold.
  const sortedMags = mags.slice(minBin).sort((a, b) => a - b);
  const medianMag = sortedMags.length ? sortedMags[sortedMags.length >> 1]! : 0;
  if (best === 0 || bestMag <= 1e-4 || bestMag < medianMag * 4) {
    return { hz: 0, phaseRad: 0, magnitude: 0 };
  }
  // Parabolic interpolation across neighbouring magnitude bins, clamped to
  // half a bin so the corrected frequency can never jump bins.
  const ml = Math.hypot(re[best - 1] as number, im[best - 1] as number);
  const mr = Math.hypot(re[best + 1] ?? 0, im[best + 1] ?? 0);
  const denom = ml - 2 * bestMag + mr;
  const rawShift = denom !== 0 ? (0.5 * (ml - mr)) / denom : 0;
  const shift = clamp(rawShift, -0.5, 0.5);
  const hz = ((best + shift) * fs) / fftLen;
  const phase = Math.atan2(im[best] as number, re[best] as number) +
    (TAU * shift * best) / fftLen;
  return { hz, phaseRad: phase, magnitude: bestMag };
}

/**
 * Fit y = c + a*sin(w*t) + b*cos(w*t) by linear least squares at fixed w.
 * Returns { offset, amplitude, phaseRad } with phase so the term is
 * amplitude * sin(w*t + phase).
 */
export function fitSinusoid(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  omega: number,
): { offset: number; amplitude: number; phaseRad: number; r2: number } {
  const n = t.length;
  // Normal equations for basis [1, sin, cos].
  let s11 = n, s12 = 0, s13 = 0;
  let s22 = 0, s23 = 0, s33 = 0;
  let v1 = 0, v2 = 0, v3 = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[i] as number;
    const yi = y[i] as number;
    const s = Math.sin(omega * ti);
    const c = Math.cos(omega * ti);
    s12 += s; s13 += c;
    s22 += s * s; s23 += s * c; s33 += c * c;
    v1 += yi; v2 += yi * s; v3 += yi * c;
  }
  // Solve 3x3 via Cramer's rule (matrices here are small and well-conditioned).
  const det =
    s11 * (s22 * s33 - s23 * s23) -
    s12 * (s12 * s33 - s23 * s13) +
    s13 * (s12 * s23 - s22 * s13);
  if (Math.abs(det) < 1e-12) return { offset: mean(y), amplitude: 0, phaseRad: 0, r2: 0 };
  const c0 =
    (v1 * (s22 * s33 - s23 * s23) - s12 * (v2 * s33 - s23 * v3) +
      s13 * (v2 * s23 - s22 * v3)) / det;
  const a =
    (s11 * (v2 * s33 - s23 * v3) - v1 * (s12 * s33 - s23 * s13) +
      s13 * (s12 * v3 - v2 * s13)) / det;
  const b =
    (s11 * (s22 * v3 - v2 * s23) - s12 * (s12 * v3 - v2 * s13) +
      v1 * (s12 * s23 - s22 * s13)) / det;
  const amplitude = Math.hypot(a, b);
  // a*sin + b*cos = amplitude*sin(wt + phase)
  const phaseRad = Math.atan2(b, a);
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[i] as number;
    const yi = y[i] as number;
    const pred = c0 + a * Math.sin(omega * ti) + b * Math.cos(omega * ti);
    const d = yi - c0;
    ssTot += d * d;
    ssRes += (yi - pred) * (yi - pred);
  }
  const r2 = ssTot > 1e-12 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;
  return { offset: c0, amplitude, phaseRad: phaseRad, r2 };
}

/**
 * Weighted sinusoid fit. Sample weights let occluded frames be excluded
 * (weight 0) without disturbing the time grid. Same basis as fitSinusoid.
 */
export function fitSinusoidWeighted(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  omega: number,
  weights: ArrayLike<number>,
): { offset: number; amplitude: number; phaseRad: number; r2: number } {
  const n = t.length;
  let s11 = 0, s12 = 0, s13 = 0;
  let s22 = 0, s23 = 0, s33 = 0;
  let v1 = 0, v2 = 0, v3 = 0;
  for (let i = 0; i < n; i++) {
    const wi = weights[i] as number;
    if (wi <= 0) continue;
    const ti = t[i] as number;
    const yi = y[i] as number;
    const s = Math.sin(omega * ti);
    const c = Math.cos(omega * ti);
    s11 += wi;
    s12 += wi * s; s13 += wi * c;
    s22 += wi * s * s; s23 += wi * s * c; s33 += wi * c * c;
    v1 += wi * yi; v2 += wi * yi * s; v3 += wi * yi * c;
  }
  if (s11 < 1e-9) return { offset: 0, amplitude: 0, phaseRad: 0, r2: 0 };
  const det =
    s11 * (s22 * s33 - s23 * s23) -
    s12 * (s12 * s33 - s23 * s13) +
    s13 * (s12 * s23 - s22 * s13);
  if (Math.abs(det) < 1e-12) return { offset: v1 / s11, amplitude: 0, phaseRad: 0, r2: 0 };
  const c0 =
    (v1 * (s22 * s33 - s23 * s23) - s12 * (v2 * s33 - s23 * v3) +
      s13 * (v2 * s23 - s22 * v3)) / det;
  const a =
    (s11 * (v2 * s33 - s23 * v3) - v1 * (s12 * s33 - s23 * s13) +
      s13 * (s12 * v3 - v2 * s13)) / det;
  const b =
    (s11 * (s22 * v3 - v2 * s23) - s12 * (s12 * v3 - v2 * s13) +
      v1 * (s12 * s23 - s22 * s13)) / det;
  const amplitude = Math.hypot(a, b);
  const phaseRad = Math.atan2(b, a);
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const wi = weights[i] as number;
    if (wi <= 0) continue;
    const ti = t[i] as number;
    const yi = y[i] as number;
    const pred = c0 + a * Math.sin(omega * ti) + b * Math.cos(omega * ti);
    const d = yi - c0;
    ssTot += wi * d * d;
    ssRes += wi * (yi - pred) * (yi - pred);
  }
  const r2 = ssTot > 1e-12 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;
  return { offset: c0, amplitude, phaseRad, r2 };
}

/** Weighted linear regression y = a*x + b. */
export function linearFit(x: number[], y: number[], w?: number[]): { slope: number; offset: number; r2: number } {
  const weights = w ?? x.map(() => 1);
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const wi = weights[i]!;
    sw += wi;
    sx += wi * x[i]!;
    sy += wi * y[i]!;
    sxx += wi * x[i]! * x[i]!;
    sxy += wi * x[i]! * y[i]!;
  }
  if (sw < 1e-9) return { slope: 0, offset: 0, r2: 0 };
  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { slope: 0, offset: sy / sw, r2: 0 };
  const slope = (sw * sxy - sx * sy) / denom;
  const offset = (sy - slope * sx) / sw;
  let ssTot = 0;
  let ssRes = 0;
  const yMean = sy / sw;
  for (let i = 0; i < x.length; i++) {
    const pred = slope * x[i]! + offset;
    ssTot += weights[i]! * (y[i]! - yMean) * (y[i]! - yMean);
    ssRes += weights[i]! * (y[i]! - pred) * (y[i]! - pred);
  }
  const r2 = ssTot > 1e-12 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;
  return { slope, offset, r2 };
}

export function pointInPolygon(x: number, y: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2] as number;
    const yi = poly[i * 2 + 1] as number;
    const xj = poly[j * 2] as number;
    const yj = poly[j * 2 + 1] as number;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance from point to segment, used for mask feathering. */
export function distanceToSegment(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function distanceToPolygon(
  x: number, y: number, poly: ArrayLike<number>,
): number {
  const n = poly.length / 2;
  let d = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    d = Math.min(
      d,
      distanceToSegment(
        x, y,
        poly[i * 2] as number, poly[i * 2 + 1] as number,
        poly[j * 2] as number, poly[j * 2 + 1] as number,
      ),
    );
  }
  return d;
}
