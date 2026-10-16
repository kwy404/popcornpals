// AudioWorklet that cleans the outgoing microphone before it reaches the
// peer connections ("Strong" noise suppression, see core/dsp.js).
import { NoiseSuppressor } from '../core/dsp.js';

class Denoise extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dsp = new NoiseSuppressor({ sampleRate, sensitivity: options.processorOptions?.sensitivity ?? 0.5 });
    this.blocks = 0;
    this.port.onmessage = (e) => {
      if (typeof e.data?.sensitivity === 'number') this.dsp.setSensitivity(e.data.sensitivity);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!input) {
      for (const ch of output) ch.fill(0);
      return true;
    }
    this.dsp.process(input, output[0]);
    for (let c = 1; c < output.length; c++) output[c].set(output[0]);
    if (++this.blocks % 15 === 0) this.port.postMessage({ ...this.dsp.level, threshold: this.dsp.threshold });
    return true;
  }
}

registerProcessor('popcornpals-denoise', Denoise);
