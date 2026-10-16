import { describe, expect, it } from 'vitest';
import { DEFAULT_UPLOAD, MAX_BITRATE, MIN_BITRATE, qualityText, streamQuality } from '../src/quality.js';

describe('stream quality', () => {
  it('shares the upload between the guests', () => {
    const one = streamQuality({ guests: 1, uploadBps: 10e6, height: 1080 });
    expect(one).toMatchObject({ maxBitrate: MAX_BITRATE, height: 1080, scaleResolutionDownBy: 1, label: 'high' });
    const four = streamQuality({ guests: 4, uploadBps: 10e6, height: 1080 });
    expect(four.perGuest).toBe(2125000);
    expect(four).toMatchObject({ maxBitrate: 2125000, height: 720, scaleResolutionDownBy: 1.5, label: 'good' });
  });

  it('drops to a lower resolution on a slow upload, never below the floor', () => {
    const slow = streamQuality({ guests: 4, uploadBps: 1e6, height: 1080 });
    expect(slow).toMatchObject({ maxBitrate: MIN_BITRATE, height: 360, scaleResolutionDownBy: 3, label: 'low' });
    expect(streamQuality({ guests: 2, uploadBps: 2e6, height: 720 })).toMatchObject({ height: 480, label: 'fair', scaleResolutionDownBy: 1.5 });
  });

  it('never scales a small video up and assumes a default upload before measuring', () => {
    const r = streamQuality({ guests: 1, uploadBps: null, height: 180 });
    expect(r.scaleResolutionDownBy).toBe(1);
    expect(r.height).toBe(180);
    expect(r.perGuest).toBe(DEFAULT_UPLOAD * 0.85);
    expect(streamQuality({ guests: 0, uploadBps: 1e6 }).scaleResolutionDownBy).toBe(1);
    expect(qualityText({ height: 720, maxBitrate: 2125000 })).toBe('720p, 2.1 Mb/s');
  });
});
