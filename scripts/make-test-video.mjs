// Makes the small test video the browser test plays: 40 seconds of 320x180
// VP8 at 15 frames per second, each frame showing its own time code, with an
// Opus sound track (a soft hum and a beep every second). Everything is encoded
// with WebCodecs in a headless browser (much faster than real time) and muxed
// into WebM with Cues so it seeks instantly.
//   node scripts/make-test-video.mjs [out.webm] [browser path]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { muxWebm } from './webm.mjs';

export const VIDEO = { width: 320, height: 180, fps: 15, seconds: 40 };

/**
 * Encode the frames in a page of an already running browser and return the
 * WebM bytes. WebCodecs needs a secure context, so url must be an https or
 * localhost page (any page of the local test server works).
 */
export async function makeTestVideo(context, url, opts = VIDEO) {
  const page = await context.newPage();
  await page.goto(url);
  const result = await page.evaluate(async ({ width, height, fps, seconds }) => {
    if (!('VideoEncoder' in window) || !('AudioEncoder' in window)) throw new Error('WebCodecs is not available in this browser');
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d');
    const frames = [];
    let failure = null;
    const enc = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        frames.push({ timestamp: chunk.timestamp, key: chunk.type === 'key', data: Array.from(data) });
      },
      error: (e) => (failure = e),
    });
    enc.configure({ codec: 'vp8', width, height, bitrate: 160000, framerate: fps });
    const total = fps * seconds;
    for (let i = 0; i < total; i++) {
      const s = i / fps;
      g.fillStyle = `hsl(${(s * 9) % 360} 25% 14%)`;
      g.fillRect(0, 0, width, height);
      g.fillStyle = '#7a2633';
      g.fillRect(0, height - 14, (width * i) / total, 14);
      g.fillStyle = '#ededed';
      g.font = 'bold 54px sans-serif';
      g.textAlign = 'center';
      g.fillText(s.toFixed(1), width / 2, height / 2 + 10);
      g.font = '14px sans-serif';
      g.fillText('popcornpals test video', width / 2, 30);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % fps === 0 });
      frame.close();
      if (enc.encodeQueueSize > 30) await new Promise((r) => setTimeout(r, 5));
    }
    await enc.flush();
    if (failure) throw failure;

    const sampleRate = 48000;
    const audio = [];
    const aenc = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        audio.push({ timestamp: chunk.timestamp, data: Array.from(data) });
      },
      error: (e) => (failure = e),
    });
    aenc.configure({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 32000 });
    const block = 4800;
    for (let start = 0; start < sampleRate * seconds; start += block) {
      const pcm = new Float32Array(block);
      for (let i = 0; i < block; i++) {
        const t = (start + i) / sampleRate;
        const beep = t % 1 < 0.15 ? 0.25 * Math.sin(2 * Math.PI * 880 * t) : 0;
        pcm[i] = 0.08 * Math.sin(2 * Math.PI * 220 * t) + beep;
      }
      aenc.encode(new AudioData({ format: 'f32', sampleRate, numberOfFrames: block, numberOfChannels: 1, timestamp: Math.round((start / sampleRate) * 1e6), data: pcm }));
    }
    await aenc.flush();
    if (failure) throw failure;
    return { frames, audio, sampleRate };
  }, opts);
  await page.close();
  const frames = result.frames.map((f) => ({ ...f, data: Uint8Array.from(f.data) }));
  const audio = { sampleRate: result.sampleRate, channels: 1, frames: result.audio.map((f) => ({ ...f, data: Uint8Array.from(f.data) })) };
  return muxWebm({ width: opts.width, height: opts.height, frames, audio, durationMs: opts.seconds * 1000 });
}

export async function ensureTestVideo(context, url, file) {
  if (existsSync(file)) return file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await makeTestVideo(context, url));
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import('playwright-core');
  const { findBrowser, launchPerson } = await import('../test/browser.mjs');
  const { serve } = await import('./serve.mjs');
  const out = process.argv[2] || '.e2e/countdown.webm';
  const port = 8800 + Math.floor(Math.random() * 100);
  const server = await serve(port, 'docs', { base: '/popcornpals/' });
  const context = await launchPerson(chromium, { executablePath: findBrowser(process.argv[3]) });
  mkdirSync(dirname(out), { recursive: true });
  const bytes = await makeTestVideo(context, `http://127.0.0.1:${port}/popcornpals/`);
  writeFileSync(out, bytes);
  console.log(`wrote ${out} (${bytes.length} bytes)`);
  await context.close();
  server.close();
  process.exit(0);
}
