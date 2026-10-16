// Voice cleanup for the outgoing microphone: "Strong" noise suppression.
// Everything runs on one audio stream in small blocks (an AudioWorklet in the
// app, plain arrays in tests). No libraries.
//
//   1. High pass at 90 Hz: hum, rumble, fans and desk knocks.
//   2. Low pass at 8 kHz: hiss above the voice band.
//   3. Spectral suppression on overlapping FFT frames (sqrt Hann windows, 50%
//      overlap): an adaptive noise floor per frequency bin, a Wiener gain with
//      the decision directed SNR estimate (which keeps "musical noise" down),
//      smoothed across frequency and limited by a gain floor.
//   4. A voice activity gate: speech must stand out from the learned noise in
//      the speech band, be sustained (keyboard clicks are too short) and not
//      be spectrally flat; the gate opens fast, holds, then releases gently.
// Added latency is one FFT frame (512 samples, about 10.7 ms at 48 kHz).

/** A second order IIR filter (RBJ cookbook), direct form 1. */
export class Biquad {
  constructor(type, freq, sampleRate, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0;
    let b1;
    let b2;
    if (type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** In place radix 2 complex FFT. inverse=true computes the unscaled inverse. */
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new RangeError('FFT size must be a power of two');
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  transform(re, im, inverse = false) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sign * this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

const dB = (power) => 10 * Math.log10(power + 1e-12);

/** Map the 0..1 sensitivity slider to the speech band SNR (dB) that opens the gate. */
export const gateThreshold = (sensitivity) => 3 + (1 - Math.min(1, Math.max(0, sensitivity))) * 14;

export class NoiseSuppressor {
  /**
   * @param {{sampleRate: number, sensitivity?: number, floor?: number, gate?: boolean}} options
   * floor: lowest spectral gain (0.1 is -20 dB); gate: false keeps only the spectral part.
   */
  constructor({ sampleRate, sensitivity = 0.5, floor = 0.1, gate = true }) {
    this.sampleRate = sampleRate;
    this.n = sampleRate >= 32000 ? 512 : 256;
    this.hop = this.n / 2;
    this.bins = this.n / 2 + 1;
    this.fft = new FFT(this.n);
    this.window = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n));
    this.hp = new Biquad('highpass', 90, sampleRate);
    this.hp2 = new Biquad('highpass', 90, sampleRate);
    this.lp = new Biquad('lowpass', 8000, sampleRate);
    this.input = new Float32Array(this.n);
    this.ola = new Float32Array(this.n);
    this.out = new Float32Array(this.hop);
    this.filled = 0;
    this.outPos = this.hop;
    this.re = new Float64Array(this.n);
    this.im = new Float64Array(this.n);
    this.noise = new Float64Array(this.bins);
    this.prevGain = new Float64Array(this.bins).fill(1);
    this.prevGamma = new Float64Array(this.bins).fill(1);
    this.gain = new Float64Array(this.bins);
    this.frames = 0;
    this.floor = floor;
    this.useGate = gate;
    this.setSensitivity(sensitivity);
    const hz = sampleRate / this.n;
    this.bandLo = Math.max(1, Math.round(300 / hz));
    this.bandHi = Math.min(this.bins - 1, Math.round(3400 / hz));
    // Gate envelope
    this.gateGain = 0;
    this.speechRun = 0;
    this.holdLeft = 0;
    this.attack = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.12 * sampleRate));
    this.holdFrames = Math.round((0.25 * sampleRate) / this.hop);
    this.openAfter = Math.max(2, Math.round((0.02 * sampleRate) / this.hop));
    this.gateFloor = 0.003;
    // Meters
    this.level = { input: -100, output: -100, snr: 0, open: false };
    this.inEnergy = 0;
    this.outEnergy = 0;
    this.meterCount = 0;
  }

  setSensitivity(sensitivity) {
    this.sensitivity = sensitivity;
    this.threshold = gateThreshold(sensitivity);
  }

  /** Whether the gate is open (speech detected, or holding after speech). */
  get open() {
    return this.speechRun >= this.openAfter || this.holdLeft > 0;
  }

  _frame() {
    const { n, re, im, window: w } = this;
    for (let i = 0; i < n; i++) {
      re[i] = this.input[i] * w[i];
      im[i] = 0;
    }
    this.fft.transform(re, im);
    const bins = this.bins;
    const power = new Float64Array(bins);
    for (let k = 0; k < bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    this.frames++;

    // Speech band statistics for the gate
    let sig = 0;
    let nse = 0;
    let logSum = 0;
    for (let k = this.bandLo; k <= this.bandHi; k++) {
      sig += power[k];
      nse += this.noise[k];
      logSum += Math.log(power[k] + 1e-12);
    }
    const count = this.bandHi - this.bandLo + 1;
    const flatness = Math.exp(logSum / count) / (sig / count + 1e-12);
    const learning = this.frames <= 12;
    const snr = learning ? 0 : dB(sig) - dB(nse);
    const loud = dB(sig / count) > -95;
    const speech = !learning && loud && snr > this.threshold && flatness < 0.45;
    this.level.snr = snr;

    // Adaptive noise floor: falls fast, rises slowly (faster while nobody speaks)
    for (let k = 0; k < bins; k++) {
      const p = power[k];
      if (learning) this.noise[k] = this.frames === 1 ? p : this.noise[k] + (p - this.noise[k]) / this.frames;
      else if (p < this.noise[k]) this.noise[k] += (p - this.noise[k]) * 0.25;
      else this.noise[k] += (p - this.noise[k]) * (speech ? 0.0008 : 0.03);
    }

    // Wiener gain with the decision directed a priori SNR
    for (let k = 0; k < bins; k++) {
      const gamma = power[k] / (this.noise[k] * 1.4 + 1e-12);
      const xi = 0.97 * this.prevGain[k] * this.prevGain[k] * this.prevGamma[k] + 0.03 * Math.max(gamma - 1, 0);
      this.gain[k] = Math.max(this.floor, xi / (1 + xi));
      this.prevGamma[k] = gamma;
    }
    for (let k = 0; k < bins; k++) {
      const g = 0.25 * this.gain[Math.max(0, k - 1)] + 0.5 * this.gain[k] + 0.25 * this.gain[Math.min(bins - 1, k + 1)];
      this.prevGain[k] = g;
      re[k] *= g;
      im[k] *= g;
      if (k > 0 && k < n / 2) {
        re[n - k] = re[k];
        im[n - k] = -im[k];
      }
    }
    this.fft.transform(re, im, true);
    for (let i = 0; i < n; i++) this.ola[i] += (re[i] / n) * w[i];

    // Gate decision: sustained speech opens it, then it holds
    this.speechRun = speech ? this.speechRun + 1 : 0;
    if (this.speechRun >= this.openAfter) this.holdLeft = this.holdFrames;
    else if (this.holdLeft > 0) this.holdLeft--;
    this.level.open = this.open;
  }

  /** Process a block of samples into out (a new Float32Array of the same length when omitted). */
  process(block, out = new Float32Array(block.length)) {
    const { hop, n } = this;
    for (let i = 0; i < block.length; i++) {
      let x = block[i];
      this.inEnergy += x * x;
      x = this.lp.step(this.hp2.step(this.hp.step(x)));
      // Slide one sample into the analysis window
      this.input[n - hop + this.filled] = x;
      this.filled++;
      if (this.filled === hop) {
        this._frame();
        this.out.set(this.ola.subarray(0, hop));
        this.ola.copyWithin(0, hop);
        this.ola.fill(0, n - hop);
        this.input.copyWithin(0, hop);
        this.filled = 0;
        this.outPos = 0;
      }
      let y = this.outPos < hop ? this.out[this.outPos++] : 0;
      if (this.useGate) {
        const target = this.open ? 1 : this.gateFloor;
        this.gateGain += (target - this.gateGain) * (target > this.gateGain ? this.attack : this.release);
        y *= this.gateGain;
      }
      out[i] = y;
      this.outEnergy += y * y;
    }
    this.meterCount += block.length;
    if (this.meterCount >= this.sampleRate * 0.05) {
      this.level.input = dB(this.inEnergy / this.meterCount);
      this.level.output = dB(this.outEnergy / this.meterCount);
      this.inEnergy = this.outEnergy = this.meterCount = 0;
    }
    return out;
  }
}
