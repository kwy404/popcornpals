import { describe, expect, it } from 'vitest';
import { Biquad, FFT, NoiseSuppressor, gateThreshold } from '../src/dsp.js';
import { SR, bandDb, clicks, energyDb, hum, mix, pink, run, voice } from './dsp-signals.js';

const len = SR * 4;
const noise = () => mix(pink(len, -42), hum(len, -40), clicks(len, 0.08));
function speechBetween(from, to) {
  const s = voice(len, -22);
  for (let i = 0; i < len; i++) if (i < from * SR || i >= to * SR) s[i] = 0;
  return s;
}

function measure(input, options) {
  const p = new NoiseSuppressor({ sampleRate: SR, ...options });
  const open = { noise: [0, 0], speech: [0, 0] };
  const out = run(p, input, (i, pr) => {
    const t = i / SR;
    if (t > 0.5 && t < 1.4) open.noise = [open.noise[0] + (pr.open ? 1 : 0), open.noise[1] + 1];
    if (t > 1.6 && t < 2.9) open.speech = [open.speech[0] + (pr.open ? 1 : 0), open.speech[1] + 1];
  });
  return { out, openNoise: open.noise[0] / open.noise[1], openSpeech: open.speech[0] / open.speech[1] };
}

describe('building blocks', () => {
  it('computes an FFT that inverts exactly', () => {
    const fft = new FFT(64);
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + 0.5 * Math.cos(3 * i));
    const im = new Float64Array(64);
    const copy = Float64Array.from(re);
    fft.transform(re, im);
    fft.transform(re, im, true);
    for (let i = 0; i < 64; i++) expect(re[i] / 64).toBeCloseTo(copy[i], 9);
    expect(() => new FFT(100)).toThrow(RangeError);
  });

  it('high passes hum and low passes hiss', () => {
    const tone = (f) => Float32Array.from({ length: SR }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));
    const through = (type, f, freq) => {
      const b = new Biquad(type, freq, SR);
      return energyDb(tone(f).map((x) => b.step(x)), SR / 2) - energyDb(tone(f), SR / 2);
    };
    expect(through('highpass', 30, 90)).toBeLessThan(-15);
    expect(through('highpass', 1000, 90)).toBeGreaterThan(-0.5);
    expect(through('lowpass', 14000, 8000)).toBeLessThan(-8);
    expect(through('lowpass', 1000, 8000)).toBeGreaterThan(-0.5);
  });

  it('opens the gate more easily with higher sensitivity', () => {
    expect(gateThreshold(1)).toBeLessThan(gateThreshold(0.5));
    expect(gateThreshold(0.5)).toBeLessThan(gateThreshold(0));
    expect(gateThreshold(5)).toBe(gateThreshold(1));
  });
});

describe('noise suppression', () => {
  it('adds about one frame of latency, well under 30 ms', () => {
    const p = new NoiseSuppressor({ sampleRate: SR });
    expect(p.n / SR).toBeLessThan(0.03);
  });

  it('removes pink noise, fan hum and keyboard clicks between words and keeps the voice', () => {
    const speech = speechBetween(1.5, 3);
    const input = mix(speech, noise());
    const { out, openNoise, openSpeech } = measure(input);
    const idleDrop = energyDb(input, 0.5 * SR, 1.4 * SR) - energyDb(out, 0.5 * SR, 1.4 * SR);
    const afterDrop = energyDb(input, 3.3 * SR, 3.9 * SR) - energyDb(out, 3.3 * SR, 3.9 * SR);
    const keep = bandDb(out, 300, 3400, FFT, 1.6 * SR, 2.9 * SR) - bandDb(speech, 300, 3400, FFT, 1.6 * SR, 2.9 * SR);
    expect(idleDrop).toBeGreaterThan(40);
    expect(afterDrop).toBeGreaterThan(20);
    expect(Math.abs(keep)).toBeLessThan(3);
    expect(openNoise).toBe(0);
    expect(openSpeech).toBeGreaterThan(0.9);
  });

  it('lowers steady noise with the spectral part alone, without the gate', () => {
    const input = mix(speechBetween(1.5, 3), pink(len, -42), hum(len, -40));
    const { out } = measure(input, { gate: false });
    const drop = energyDb(input, 0.5 * SR, 1.4 * SR) - energyDb(out, 0.5 * SR, 1.4 * SR);
    expect(drop).toBeGreaterThan(15);
  });

  it('keeps the gate closed for loud keyboard clicks, fans and hum with nobody talking', () => {
    for (const input of [clicks(len, 0.3), mix(pink(len, -30), hum(len, -28)), mix(clicks(len, 0.2, 4), pink(len, -45))]) {
      const p = new NoiseSuppressor({ sampleRate: SR });
      let opened = 0;
      let blocks = 0;
      run(p, input, (i, pr) => {
        if (i / SR > 0.4) {
          blocks++;
          if (pr.open) opened++;
        }
      });
      expect(opened / blocks).toBeLessThan(0.02);
    }
  });

  it('reports meter levels for the settings screen', () => {
    const p = new NoiseSuppressor({ sampleRate: SR });
    run(p, mix(speechBetween(0.5, 2), pink(len, -45)).subarray(0, SR * 2));
    expect(p.level.input).toBeGreaterThan(-60);
    expect(p.level.input).toBeLessThan(0);
    expect(typeof p.level.open).toBe('boolean');
  });
});
