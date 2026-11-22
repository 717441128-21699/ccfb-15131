import { describe, it, expect } from 'vitest';
import {
  fft,
  dominantFrequency,
  fitSinusoid,
  linearFit,
  TAU,
} from '../src/analysis/mathUtils';

describe('FFT', () => {
  it('recovers a pure tone bin', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((TAU * 4 * i) / n);
    fft(re, im);
    let peak = 0;
    let mag = -1;
    for (let k = 1; k < n / 2; k++) {
      const m = Math.hypot(re[k]!, im[k]!);
      if (m > mag) {
        mag = m;
        peak = k;
      }
    }
    expect(peak).toBe(4);
  });
});

describe('dominantFrequency', () => {
  it('finds a 7 Hz component at 60 fps', () => {
    const fs = 60;
    const n = 256;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = 0.5 + 0.3 * Math.sin(TAU * 7 * (i / fs));
    const out = dominantFrequency(sig, fs);
    expect(out.hz).toBeCloseTo(7, 0);
    expect(out.magnitude).toBeGreaterThan(0.1);
  });

  it('returns zero for a flat signal', () => {
    const sig = new Float32Array(64).fill(0.42);
    const out = dominantFrequency(sig, 30);
    expect(out.hz).toBe(0);
  });
});

describe('fitSinusoid', () => {
  it('recovers known amplitude and offset with high R²', () => {
    const n = 128;
    const fs = 30;
    const t = Array.from({ length: n }, (_, i) => i / fs);
    const y = t.map((ti) => 0.6 + 0.22 * Math.sin(TAU * 5 * ti + 0.7));
    const fit = fitSinusoid(t, y, TAU * 5);
    expect(fit.offset).toBeCloseTo(0.6, 2);
    expect(fit.amplitude).toBeCloseTo(0.22, 2);
    expect(fit.phaseRad).toBeCloseTo(0.7, 1);
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  it('handles noisy signals gracefully', () => {
    const n = 128;
    const fs = 30;
    const t = Array.from({ length: n }, (_, i) => i / fs);
    const y = t.map((ti, i) => 0.5 + 0.2 * Math.sin(TAU * 6 * ti) + ((i * 7919) % 13) / 130 - 0.05);
    const fit = fitSinusoid(t, y, TAU * 6);
    expect(fit.r2).toBeGreaterThan(0.8);
    expect(fit.amplitude).toBeGreaterThan(0.1);
  });
});

describe('linear regression shim', () => {
  it('fits a perfect line', () => {
    const x = [0, 1, 2, 3, 4];
    const y = x.map((v) => 2 * v + 1);
    const fit = linearFit(x, y);
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.offset).toBeCloseTo(1, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
  });
});
