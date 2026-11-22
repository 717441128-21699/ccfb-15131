/**
 * Tiny observable store (no framework dependency).
 * Holds clip metadata, pipeline settings, analysis results and UI state.
 */

import { DEFAULT_SETTINGS, type AppSettings, type QualityMetrics, type ScreenRegion } from '../types';

export type PageId = 'media' | 'calibration' | 'preview' | 'export';

export interface ClipMeta {
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
  isSynthetic: boolean;
  syntheticId?: string;
}

export interface AppState {
  page: PageId;
  clip: ClipMeta | null;
  settings: AppSettings;
  regions: ScreenRegion[];
  detectionScoreGrid: Float32Array | null;
  metrics: QualityMetrics | null;
  gpuMsSamples: number[];
  processing: boolean;
  progress: number;
  log: string[];
}

type Listener = (state: AppState) => void;

export class Store {
  private state: AppState = {
    page: 'media',
    clip: null,
    settings: { ...DEFAULT_SETTINGS },
    regions: [],
    detectionScoreGrid: null,
    metrics: null,
    gpuMsSamples: [],
    processing: false,
    progress: 0,
    log: [],
  };
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  patchSettings(patch: Partial<AppSettings>): void {
    this.update({ settings: { ...this.state.settings, ...patch } });
  }

  logLine(line: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.update({ log: [...this.state.log.slice(-199), `[${stamp}] ${line}`] });
  }
}

export const store = new Store();
