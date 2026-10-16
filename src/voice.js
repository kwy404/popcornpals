// Voice settings and the movie ducking rule.
//
// Noise suppression has three modes: 'off', 'browser' (the browser's own
// noise suppression) and 'strong' (the browser's plus our own DSP in an
// AudioWorklet, see dsp.js). Echo cancellation and automatic gain stay on in
// every mode, because the movie plays through the same speakers.
//
// Ducking lowers the movie while someone talks, so voices are easy to hear.

export const NOISE_MODES = Object.freeze(['off', 'browser', 'strong']);

/** getUserMedia audio constraints for a noise mode. */
export function micConstraints({ noiseMode = 'strong', supported = {}, inputId = '' } = {}) {
  const clean = noiseMode !== 'off';
  const audio = { echoCancellation: true, autoGainControl: true, noiseSuppression: clean };
  if (supported.voiceIsolation) audio.voiceIsolation = clean;
  if (inputId) audio.deviceId = { exact: inputId };
  return audio;
}

/** Whether our own noise suppression worklet runs in this mode. */
export const usesWorklet = (noiseMode) => noiseMode === 'strong';

export const DUCK = Object.freeze({
  /** Voice level (0 to 1) that counts as talking. */
  TALK: 0.08,
  /** The movie volume, as a fraction, while someone talks. */
  LOW: 0.35,
  /** How long (ms) the movie stays low after the last word. */
  HOLD: 700,
  /** Fraction of the way to the target per step: down fast, up slowly. */
  DOWN: 0.5,
  UP: 0.12,
});

/**
 * One step of the ducking: from the current gain, the remote voice levels
 * and the time the last voice was heard, the next gain and that time.
 * Returns { gain, lastTalk }.
 */
export function duckStep({ gain = 1, levels = [], lastTalk = -Infinity, now, enabled = true }, opts = DUCK) {
  const talking = enabled && levels.some((l) => l >= opts.TALK);
  const last = talking ? now : lastTalk;
  const target = enabled && now - last < opts.HOLD ? opts.LOW : 1;
  const k = target < gain ? opts.DOWN : opts.UP;
  let next = gain + (target - gain) * k;
  if (Math.abs(next - target) < 0.01) next = target;
  return { gain: Math.round(next * 1000) / 1000, lastTalk: last };
}
