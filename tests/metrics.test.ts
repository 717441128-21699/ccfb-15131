import { describe, it, expect } from 'vitest';
import {
  outsideChangedFraction,
  textContrastRatio,
  flickerAttenuationDb,
  occlusionLeak,
  summarizeQa,
  type RgbaFrame,
} from '../src/qa/metrics';

function makeFrame(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('outsideChangedFraction', () => {
  it('is zero for identical frames', () => {
    const a = makeFrame(40, 30, () => [100, 100, 100]);
    const b = makeFrame(40, 30, () => [100, 100, 100]);
    const mask = new Uint8Array(40 * 30);
    expect(outsideChangedFraction(a, b, mask)).toBe(0);
  });

  it('ignores changes inside the screen mask', () => {
    const w = 40;
    const h = 30;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 5; x < 35; x++) mask[y * w + x] = 1;
    const a = makeFrame(w, h, () => [120, 120, 120]);
    const b = makeFrame(w, h, (x, y) => (mask[y * w + x] ? [40, 200, 60] : [120, 120, 120]));
    expect(outsideChangedFraction(a, b, mask)).toBe(0);
  });

  it('counts outside changes correctly and flags the 0.5% budget', () => {
    const w = 100;
    const h = 100;
    const mask = new Uint8Array(w * h); // nothing is screen
    const a = makeFrame(w, h, () => [100, 100, 100]);
    const b = makeFrame(w, h, (x, y) => (x < 10 && y < 10 ? [140, 140, 140] : [100, 100, 100]));
    const fraction = outsideChangedFraction(a, b, mask);
    expect(fraction).toBeCloseTo(0.01, 3);
    const report = summarizeQa({
      outsideChangedFraction: fraction,
      textContrastRatio: 1,
      flickerAttenuationDb: 20,
      occlusionLeak: 0,
      gpuMsSamples: [5, 6, 7],
    });
    expect(report.meetsOutsideBudget).toBe(false);
  });

  it('treats a one-step luma difference as unchanged (quantization tolerance)', () => {
    const w = 20;
    const h = 20;
    const mask = new Uint8Array(w * h);
    const a = makeFrame(w, h, () => [100, 100, 100]);
    const b = makeFrame(w, h, () => [101, 101, 101]);
    expect(outsideChangedFraction(a, b, mask)).toBe(0);
  });
});

describe('textContrastRatio', () => {
  it('is 1 when frames are identical', () => {
    const a = makeFrame(60, 40, (x) => [((x / 4) | 0) % 2 ? 220 : 30, 50, 50]);
    const mask = new Uint8Array(60 * 40).fill(1);
    expect(textContrastRatio(a, a, mask, 3)).toBeCloseTo(1, 5);
  });

  it('stays >= 1 when local deviations are preserved', () => {
    const w = 60;
    const h = 40;
    const mask = new Uint8Array(w * h).fill(1);
    const orig = makeFrame(w, h, (x) => ((x / 3) | 0) % 2 ? [210, 210, 210] : [40, 40, 40]);
    // Uniform gain keeps deviation ratio identical in linear light.
    const proc = makeFrame(w, h, (x) => ((x / 3) | 0) % 2 ? [215, 215, 215] : [35, 35, 35]);
    expect(textContrastRatio(orig, proc, mask, 3)).toBeGreaterThanOrEqual(0.99);
  });
});

describe('flickerAttenuationDb', () => {
  it('returns positive dB when processed series is flatter', () => {
    const orig = Array.from({ length: 60 }, (_, i) => 0.5 + 0.2 * Math.sin(i * 0.8));
    const proc = orig.map((v) => 0.5 + (v - 0.5) * 0.1);
    const db = flickerAttenuationDb(orig, proc);
    expect(db).toBeGreaterThan(15);
  });

  it('is ~0 dB when nothing changed', () => {
    const s = Array.from({ length: 40 }, (_, i) => 0.5 + 0.1 * Math.sin(i));
    expect(Math.abs(flickerAttenuationDb(s, s))).toBeLessThan(1e-9);
  });
});

describe('occlusionLeak', () => {
  it('is zero when occluded pixels are passed through untouched', () => {
    const w = 16;
    const h = 16;
    const a = makeFrame(w, h, (x, y) => [(x * 7 + y * 3) % 256, 20, 90]);
    const occ = new Uint8Array(w * h);
    for (let i = 0; i < 40; i++) occ[i] = 1;
    expect(occlusionLeak(a, a, occ)).toBe(0);
  });

  it('accumulates channel differences inside the occluder only', () => {
    const w = 8;
    const h = 8;
    const a = makeFrame(w, h, () => [100, 100, 100]);
    const b = makeFrame(w, h, () => [110, 100, 100]);
    const occ = new Uint8Array(w * h).fill(1);
    expect(occlusionLeak(a, b, occ)).toBeCloseTo(10 / 3, 1);
  });
});
