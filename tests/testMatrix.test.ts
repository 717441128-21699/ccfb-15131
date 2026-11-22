import { describe, it, expect } from 'vitest';
import {
  FULL_MATRIX,
  SHUTTER_SPECS,
  REFRESH_SPECS,
  mulberry32,
  DEFAULT_CLIP_CONFIG,
} from '../src/synthetic/testClipGenerator';

describe('synthetic test matrix', () => {
  it('contains exactly 24 shutter x refresh combinations', () => {
    expect(SHUTTER_SPECS.length).toBe(4);
    expect(REFRESH_SPECS.length).toBe(6);
    expect(FULL_MATRIX.length).toBe(24);
  });

  it('every combination has a unique id and valid specs', () => {
    const ids = new Set<string>();
    for (const combo of FULL_MATRIX) {
      expect(combo.id).toBe(`${combo.shutter.id}_${combo.refresh.id}`);
      expect(ids.has(combo.id)).toBe(false);
      ids.add(combo.id);
      expect(combo.shutter.shutterAngleDeg).toBeGreaterThan(0);
      expect(combo.shutter.shutterAngleDeg).toBeLessThanOrEqual(360);
      expect(combo.refresh.refreshHz).toBeGreaterThan(0);
    }
    expect(ids.size).toBe(24);
  });

  it('covers the full shutter-angle and refresh-rate ranges', () => {
    const angles = SHUTTER_SPECS.map((s) => s.shutterAngleDeg).sort((a, b) => a - b);
    expect(angles).toEqual([90, 180, 270, 360]);
    const rates = REFRESH_SPECS.map((r) => r.refreshHz).sort((a, b) => a - b);
    expect(rates).toEqual([192, 240, 300, 384, 480, 600]);
  });

  it('default config is internally consistent', () => {
    expect(DEFAULT_CLIP_CONFIG.width).toBe(1920);
    expect(DEFAULT_CLIP_CONFIG.height).toBe(1080);
    expect(DEFAULT_CLIP_CONFIG.frameCount).toBeGreaterThan(0);
    expect(DEFAULT_CLIP_CONFIG.flickerAmplitude).toBeGreaterThan(0);
    expect(DEFAULT_CLIP_CONFIG.flickerAmplitude).toBeLessThan(1);
  });
});

describe('mulberry32 PRNG', () => {
  it('is deterministic for a fixed seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 10 }, a);
    const seqB = Array.from({ length: 10 }, b);
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0,1)', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    const a = Array.from({ length: 8 }, mulberry32(1));
    const b = Array.from({ length: 8 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });
});
