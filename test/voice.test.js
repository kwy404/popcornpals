import { describe, expect, it } from 'vitest';
import { DUCK, duckStep, micConstraints, usesWorklet } from '../src/voice.js';

describe('voice settings', () => {
  it('keeps echo cancellation on and switches noise suppression by mode', () => {
    expect(micConstraints({ noiseMode: 'strong' })).toEqual({ echoCancellation: true, autoGainControl: true, noiseSuppression: true });
    expect(micConstraints({ noiseMode: 'off' }).noiseSuppression).toBe(false);
    expect(micConstraints({ noiseMode: 'browser', supported: { voiceIsolation: true }, inputId: 'abc' })).toMatchObject({ voiceIsolation: true, deviceId: { exact: 'abc' } });
    expect(usesWorklet('strong')).toBe(true);
    expect(usesWorklet('browser')).toBe(false);
  });
});

describe('ducking the movie while someone talks', () => {
  it('goes down quickly when a voice starts', () => {
    let s = { gain: 1, lastTalk: -Infinity };
    s = duckStep({ ...s, levels: [0.3], now: 0 });
    expect(s.gain).toBeLessThan(0.7);
    for (let t = 100; t < 1000; t += 100) s = duckStep({ ...s, levels: [0.3], now: t });
    expect(s.gain).toBe(DUCK.LOW);
  });

  it('holds through short pauses between words, then comes back slowly', () => {
    let s = { gain: DUCK.LOW, lastTalk: 1000 };
    s = duckStep({ ...s, levels: [0], now: 1300 });
    expect(s.gain).toBe(DUCK.LOW);
    s = duckStep({ ...s, levels: [0], now: 2000 });
    expect(s.gain).toBeGreaterThan(DUCK.LOW);
    expect(s.gain).toBeLessThan(0.5);
    for (let t = 2100; t < 6000; t += 100) s = duckStep({ ...s, levels: [0.01], now: t });
    expect(s.gain).toBe(1);
  });

  it('does nothing when turned off', () => {
    expect(duckStep({ gain: 1, levels: [0.9], now: 0, enabled: false }).gain).toBe(1);
    expect(duckStep({ gain: 0.35, levels: [0.9], now: 0, enabled: false }).gain).toBeGreaterThan(0.35);
  });
});
