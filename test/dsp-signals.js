// Synthetic test signals for the noise suppressor: a voice like source, pink
// noise, fan hum and keyboard clicks, all deterministic.

export const SR = 48000;

export function rng(seed = 7) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Pink noise (Paul Kellet's filter on white noise), scaled to an RMS level in dBFS. */
export function pink(len, dbfs, seed = 3) {
  const r = rng(seed);
  const out = new Float32Array(len);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = r();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return scale(out, dbfs);
}

/** Fan hum: 60 Hz and harmonics with a little wobble. */
export function hum(len, dbfs) {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] = Math.sin(2 * Math.PI * 60 * t) + 0.5 * Math.sin(2 * Math.PI * 120 * t + 0.3) + 0.3 * Math.sin(2 * Math.PI * 180 * t + 1.1) + 0.15 * Math.sin(2 * Math.PI * 240 * t);
  }
  return scale(out, dbfs);
}

/** Keyboard clicks: short decaying broadband bursts every 90 to 220 ms. */
export function clicks(len, peak = 0.25, seed = 11) {
  const r = rng(seed);
  const out = new Float32Array(len);
  let at = Math.floor(0.05 * SR);
  while (at < len) {
    const dur = Math.floor(0.006 * SR);
    for (let i = 0; i < dur && at + i < len; i++) out[at + i] += r() * peak * Math.exp(-i / (0.0012 * SR));
    at += Math.floor((0.09 + 0.13 * (r() * 0.5 + 0.5)) * SR);
  }
  return out;
}

/** A voice like signal: a glottal pulse train through two moving formants, with syllables and pauses. */
export function voice(len, dbfs, seed = 5) {
  const r = rng(seed);
  const out = new Float32Array(len);
  let phase = 0;
  const f1 = { y1: 0, y2: 0 };
  const f2 = { y1: 0, y2: 0 };
  const reson = (st, x, f, bw) => {
    const rr = Math.exp((-Math.PI * bw) / SR);
    const a1 = -2 * rr * Math.cos((2 * Math.PI * f) / SR);
    const a2 = rr * rr;
    const y = (1 - rr) * x - a1 * st.y1 - a2 * st.y2;
    st.y2 = st.y1;
    st.y1 = y;
    return y;
  };
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f0 = 130 + 20 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += f0 / SR;
    if (phase >= 1) phase -= 1;
    const pulse = 1 - 2 * phase + 0.05 * r();
    const vowel = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.3 * t);
    const x = reson(f1, pulse, 500 + 300 * vowel, 90) * 6 + reson(f2, pulse, 1200 + 900 * vowel, 120) * 4;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)) ** 0.6;
    out[i] = x * syllable;
  }
  return scale(out, dbfs);
}

export function scale(sig, dbfs) {
  let e = 0;
  for (const v of sig) e += v * v;
  const rms = Math.sqrt(e / sig.length) || 1;
  const k = 10 ** (dbfs / 20) / rms;
  for (let i = 0; i < sig.length; i++) sig[i] *= k;
  return sig;
}

export function mix(...sigs) {
  const out = new Float32Array(sigs[0].length);
  for (const s of sigs) for (let i = 0; i < out.length; i++) out[i] += s[i];
  return out;
}

/** Energy in dB of a slice. */
export function energyDb(sig, from = 0, to = sig.length) {
  let e = 0;
  for (let i = from; i < to; i++) e += sig[i] * sig[i];
  return 10 * Math.log10(e / Math.max(1, to - from) + 1e-20);
}

/** Energy in dB within a frequency band, from a simple FFT sweep. */
export function bandDb(sig, lo, hi, FFTClass, from = 0, to = sig.length) {
  const n = 1024;
  const fft = new FFTClass(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let e = 0;
  let frames = 0;
  for (let start = from; start + n <= to; start += n / 2) {
    for (let i = 0; i < n; i++) {
      re[i] = sig[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = Math.round((lo * n) / SR); k <= Math.round((hi * n) / SR); k++) e += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  return 10 * Math.log10(e / Math.max(1, frames) + 1e-20);
}

/** Run a signal through a processor in 128 sample blocks, like an AudioWorklet. */
export function run(proc, sig, onBlock) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i += 128) {
    const block = proc.process(sig.subarray(i, Math.min(sig.length, i + 128)));
    out.set(block, i);
    onBlock?.(i, proc);
  }
  return out;
}
