/**
 * Frame-accurate video source built on HTMLVideoElement + requestVideoFrameCallback,
 * with an optional synthetic-canvas source for generated test clips.
 */

import type { TestClipGenerator } from '../synthetic/testClipGenerator';

export interface FrameSource {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
  /** Draw frame `index` at its exact position into the target. */
  drawFrame(index: number, target: HTMLCanvasElement): Promise<void> | void;
  /** Provide a TexImageSource for the given frame (video element or canvas). */
  frameImage(index: number): Promise<TexImageSource> | TexImageSource;
  release(): void;
}

export class VideoFileSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly durationSec: number;
  private video: HTMLVideoElement;
  private url: string;
  private seekQueue: Promise<void> | null = null;

  private constructor(video: HTMLVideoElement, url: string, fps: number) {
    this.video = video;
    this.url = url;
    this.fps = fps;
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.durationSec = video.duration;
    this.frameCount = Math.max(1, Math.round(video.duration * fps));
    video.muted = true;
    video.playsInline = true;
  }

  static async create(file: File, assumedFps = 30): Promise<VideoFileSource> {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.preload = 'auto';
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to decode video metadata'));
    });
    return new VideoFileSource(video, url, assumedFps);
  }

  private seekTo(timeSec: number): Promise<void> {
    const job = (this.seekQueue ?? Promise.resolve()).then(
      () =>
        new Promise<void>((resolve) => {
          const onSeeked = () => {
            this.video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          this.video.addEventListener('seeked', onSeeked);
          this.video.currentTime = Math.min(timeSec, Math.max(0, this.durationSec - 1e-4));
        }),
    );
    this.seekQueue = job.catch(() => undefined);
    return job;
  }

  async frameImage(index: number): Promise<TexImageSource> {
    await this.seekTo(index / this.fps);
    return this.video;
  }

  async drawFrame(index: number, target: HTMLCanvasElement): Promise<void> {
    const img = (await this.frameImage(index)) as CanvasImageSource;
    target.getContext('2d')!.drawImage(img, 0, 0, target.width, target.height);
  }

  get element(): HTMLVideoElement {
    return this.video;
  }

  release(): void {
    URL.revokeObjectURL(this.url);
    this.video.src = '';
  }
}

export class SyntheticSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly durationSec: number;
  readonly generator: TestClipGenerator;

  constructor(generator: TestClipGenerator) {
    this.generator = generator;
    this.width = generator.cfg.width;
    this.height = generator.cfg.height;
    this.fps = generator.cfg.fps;
    this.frameCount = generator.cfg.frameCount;
    this.durationSec = this.frameCount / this.fps;
  }

  frameImage(index: number): TexImageSource {
    return this.generator.renderFrame(index).canvas;
  }

  drawFrame(index: number, target: HTMLCanvasElement): void {
    const img = this.generator.renderFrame(index).canvas;
    target.getContext('2d')!.drawImage(img, 0, 0, target.width, target.height);
  }

  release(): void {
    /* canvas source needs no cleanup */
  }
}
