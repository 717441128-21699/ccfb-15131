/**
 * Processed-clip exporter.
 *
 * Primary path: WebCodecs VideoEncoder (H.264) muxed to MP4 with
 * mp4-muxer, driven directly from the renderer's output texture via
 * readPixels -> VideoFrame. Fallback: canvas.captureStream() through
 * MediaRecorder (WebM) where WebCodecs is unavailable.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { ProcessingEngine } from './ProcessingEngine';

export interface ExportOptions {
  codec: 'avc1.640028' | 'avc1.4d4032' | 'vp9';
  bitrate: number;
  onProgress?: (fraction: number) => void;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  codec: 'avc1.4d4032',
  bitrate: 12_000_000,
};

export function webCodecsSupported(): boolean {
  return typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoFrame' in window;
}

export async function exportProcessedMp4(
  engine: ProcessingEngine,
  opts: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): Promise<Blob> {
  if (!webCodecsSupported()) {
    return exportViaMediaRecorder(engine, opts);
  }
  const { width, height, fps, frameCount } = engine.source;
  const mux = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: width % 2 === 0 ? width : width - 1,
      height: height % 2 === 0 ? height : height - 1,
    },
    fastStart: 'in-memory',
  });
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      mux.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      throw err;
    },
  });
  const config: VideoEncoderConfig = {
    codec: opts.codec.startsWith('avc1') ? opts.codec : 'avc1.4d4032',
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1,
    bitrate: opts.bitrate,
    framerate: fps,
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    config.codec = 'avc1.42e01f';
  }
  encoder.configure(config);

  const rgba = new Uint8ClampedArray(width * height * 4);
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const scratchCtx = scratch.getContext('2d')!;
  const frameDuration = Math.round(1_000_000 / fps);
  for (let i = 0; i < frameCount; i++) {
    await engine.ingestFrame(i);
    engine.renderProcessed(i, false);
    const pixels = engine.renderer.readOutput();
    rgba.set(pixels);
    const imageData = new ImageData(rgba, width, height);
    scratchCtx.putImageData(imageData, 0, 0);
    const frame = new VideoFrame(scratch, {
      timestamp: i * frameDuration,
      duration: frameDuration,
    });
    const keyFrame = i % (fps * 2) === 0;
    encoder.encode(frame, { keyFrame });
    frame.close();
    opts.onProgress?.((i + 1) / frameCount);
    // Keep the encoder queue bounded.
    if (encoder.encodeQueueSize > 8) {
      await new Promise(requestAnimationFrame);
    }
  }
  await encoder.flush();
  encoder.close();
  mux.finalize();
  const target = (mux as unknown as { target: ArrayBufferTarget }).target;
  return new Blob([target.buffer], { type: 'video/mp4' });
}

/** Fallback path: realtime-ish MediaRecorder WebM capture. */
export async function exportViaMediaRecorder(
  engine: ProcessingEngine,
  opts: ExportOptions,
): Promise<Blob> {
  const { fps, frameCount } = engine.source;
  const canvas = engine.canvas;
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm',
    videoBitsPerSecond: opts.bitrate,
  });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  });
  rec.start();
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < frameCount; i++) {
    await engine.ingestFrame(i);
    engine.renderProcessed(i, false);
    ctx.drawImage(engine.renderer.gl.canvas, 0, 0);
    opts.onProgress?.((i + 1) / frameCount);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  return done;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
