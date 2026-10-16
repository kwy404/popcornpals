// Voice chat, cameras, screen sharing and file streaming over the room's
// links. Every member sends their microphone (and camera, when on) to every
// other member: a full mesh, fine for 5 people. The microphone goes through
// noise suppression first: the browser's own and, in Strong mode, the DSP
// worklet from core/dsp.js. Remote voices play in hidden audio elements; a
// small analyser per voice tells the people list who is talking.

import { Emitter } from '../core/emitter.js';
import { micConstraints, usesWorklet } from '../core/voice.js';

export class Media extends Emitter {
  constructor(sink) {
    super();
    this.sink = sink; // a hidden element that holds the audio elements
    this.mic = null; // { raw, stream, track, chain } stream/track are what peers get
    this.camera = null; // { stream, track }
    this.noiseMode = 'strong';
    this.muted = false;
    this.micId = ''; // chosen devices; '' is the system default
    this.camId = '';
    this.outId = '';
    this.screen = null; // { stream, video, audio }
    this.movie = null; // { stream } a local file this device streams to everyone
    this.remote = new Map(); // peerId -> { audio: HTMLAudioElement, stream, level }
    this.screenAudio = new Map();
    this.links = new Map();
    this.ctx = null;
    this.analysers = new Map();
    this.selfLevel = 0;
  }

  /** Called for every open link: send what this device shares right now. */
  attach(peerId, link) {
    this.links.set(peerId, link);
    if (this.mic) link.setTrack('mic', this.mic.track, this.mic.stream);
    if (this.camera) link.setTrack('camera', this.camera.track, this.camera.stream);
    if (this.screen) {
      link.setTrack('screen', this.screen.video, this.screen.stream);
      if (this.screen.audio) link.setTrack('screen-audio', this.screen.audio, this.screen.stream);
    }
    if (this.movie) this._sendMovie(link);
  }

  /**
   * Stream a playing video element (its captureStream()) to everyone. Its
   * tracks appear once the file starts to load, so they are added as they come.
   */
  startMovie(stream) {
    this.stopMovie();
    this.movie = { stream };
    const update = () => {
      if (this.movie?.stream !== stream) return;
      for (const link of this.links.values()) this._sendMovie(link);
      this.emit('change');
    };
    stream.addEventListener('addtrack', update);
    stream.addEventListener('removetrack', update);
    this.movie.update = update;
    update();
  }

  _sendMovie(link) {
    const s = this.movie.stream;
    const v = s.getVideoTracks()[0] || null;
    const a = s.getAudioTracks()[0] || null;
    if (v || link.senders.movie) link.setTrack('movie', v, s);
    if (a || link.senders['movie-audio']) link.setTrack('movie-audio', a, s);
  }

  stopMovie() {
    if (!this.movie) return;
    for (const link of this.links.values()) {
      if (link.senders.movie) link.setTrack('movie', null);
      if (link.senders['movie-audio']) link.setTrack('movie-audio', null);
    }
    this.movie = null;
    this.emit('change');
  }

  /** Cap each copy of the streamed video: one upload is shared by every guest. */
  async applyMovieQuality(q) {
    for (const link of this.links.values()) {
      const sender = link.senders.movie;
      if (!sender?.getParameters) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      const e = params.encodings[0];
      if (e.maxBitrate === q.maxBitrate && e.scaleResolutionDownBy === q.scaleResolutionDownBy) continue;
      e.maxBitrate = q.maxBitrate;
      e.scaleResolutionDownBy = q.scaleResolutionDownBy;
      params.degradationPreference = 'maintain-framerate';
      await sender.setParameters(params).catch(() => {});
    }
  }

  detach(peerId) {
    this.links.delete(peerId);
    const r = this.remote.get(peerId);
    if (r) {
      r.audio.srcObject = null;
      r.audio.remove();
      this.remote.delete(peerId);
    }
    const sa = this.screenAudio.get(peerId);
    if (sa) {
      sa.srcObject = null;
      sa.remove();
      this.screenAudio.delete(peerId);
    }
    this.analysers.delete(peerId);
  }

  get micOn() {
    return !!this.mic;
  }

  async startMic() {
    if (this.mic) return;
    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const raw = await withFallback(this.micId, (inputId) => navigator.mediaDevices.getUserMedia({ audio: micConstraints({ noiseMode: this.noiseMode, supported, inputId }), video: false }));
    for (const t of raw.getAudioTracks()) if ('contentHint' in t) t.contentHint = 'speech';
    const pipe = await this._denoise(raw);
    const track = pipe.stream.getAudioTracks()[0];
    this.mic = { raw, ...pipe, track };
    track.enabled = !this.muted;
    for (const t of raw.getAudioTracks()) t.enabled = !this.muted;
    for (const link of this.links.values()) link.setTrack('mic', track, pipe.stream);
    this._analyse('self', pipe.stream);
    this.emit('change');
  }

  /** In Strong mode, run the microphone through the noise suppression worklet. */
  async _denoise(raw) {
    if (!usesWorklet(this.noiseMode) || typeof AudioWorkletNode === 'undefined') return { stream: raw, chain: null };
    try {
      this.ctx ??= new AudioContext();
      this.workletReady ??= this.ctx.audioWorklet.addModule(new URL('./denoise-worklet.js', import.meta.url));
      await this.workletReady;
      const src = this.ctx.createMediaStreamSource(raw);
      const node = new AudioWorkletNode(this.ctx, 'popcornpals-denoise', { processorOptions: { sensitivity: 0.5 } });
      const dest = this.ctx.createMediaStreamDestination();
      src.connect(node);
      node.connect(dest);
      const chain = { src, node, dest, level: null };
      node.port.onmessage = (e) => (chain.level = e.data);
      return { stream: dest.stream, chain };
    } catch (err) {
      console.warn('popcornpals: the noise suppression worklet is not available here', err);
      this.workletReady = null;
      return { stream: raw, chain: null };
    }
  }

  /** Whether our own noise suppression is running on the microphone now. */
  get processing() {
    return this.mic ? (this.mic.chain ? 'strong' : this.noiseMode) : null;
  }

  /** Change the noise mode; an open microphone is reopened with it. */
  async setNoiseMode(mode) {
    this.noiseMode = mode;
    if (!this.mic) return;
    this._closeMic(false);
    await this.startMic();
  }

  /** Use another microphone; an open microphone moves to it and stays muted or not. */
  async setMicDevice(id) {
    this.micId = id || '';
    if (!this.mic) return;
    this._closeMic(false);
    await this.startMic();
  }

  _closeMic(tellLinks) {
    const m = this.mic;
    if (!m) return;
    if (tellLinks) for (const link of this.links.values()) link.setTrack('mic', null);
    try {
      m.chain?.src.disconnect();
      m.chain?.node.disconnect();
    } catch {
      // already disconnected
    }
    for (const t of m.raw.getTracks()) t.stop();
    if (m.stream !== m.raw) for (const t of m.stream.getTracks()) t.stop();
    this.mic = null;
    this.analysers.delete('self');
  }

  stopMic() {
    if (!this.mic) return;
    this._closeMic(true);
    this.emit('change');
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.mic) {
      this.mic.track.enabled = !this.muted;
      for (const t of this.mic.raw.getAudioTracks()) t.enabled = !this.muted;
    }
    this.emit('change');
  }

  get cameraOn() {
    return !!this.camera;
  }

  /** A small camera picture, sent to everyone and shown as a seat under the screen. */
  async startCamera() {
    if (this.camera) return this.camera.stream;
    const video = (deviceId) => ({ width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) });
    const stream = await withFallback(this.camId, (id) => navigator.mediaDevices.getUserMedia({ video: video(id), audio: false }));
    const track = stream.getVideoTracks()[0];
    this.camera = { stream, track };
    for (const link of this.links.values()) link.setTrack('camera', track, stream);
    track.addEventListener('ended', () => this.stopCamera());
    this.emit('change');
    return stream;
  }

  /** Use another camera; a camera that is on switches over at once. */
  async setCameraDevice(id) {
    this.camId = id || '';
    if (!this.camera) return;
    this.stopCamera();
    await this.startCamera();
  }

  /** Play every voice, and the given stage elements, on this output device. */
  async setOutput(id, extra = []) {
    this.outId = id || '';
    const els = [...[...this.remote.values()].map((r) => r.audio), ...this.screenAudio.values(), ...extra];
    await Promise.all(els.map((el) => sinkTo(el, this.outId)));
  }

  /** The media devices, by kind. Labels are empty until a permission was granted. */
  static async devices() {
    const out = { audioinput: [], audiooutput: [], videoinput: [] };
    try {
      for (const d of await navigator.mediaDevices.enumerateDevices()) if (out[d.kind]) out[d.kind].push(d);
    } catch {
      // no media devices API here
    }
    return out;
  }

  stopCamera() {
    if (!this.camera) return;
    for (const link of this.links.values()) link.setTrack('camera', null);
    for (const t of this.camera.stream.getTracks()) t.stop();
    this.camera = null;
    this.emit('change');
  }

  /**
   * A remote track arrived on a link. Returns 'screen' or 'movie' for the
   * tracks the stage shows (the stage's video element plays a movie's sound
   * too), 'screen-audio' or 'voice' for the ones played here.
   */
  addTrack({ peerId, track, stream, slot }) {
    if (slot === 'movie' || slot === 'movie-audio') return 'movie';
    if (slot === 'camera') return 'camera';
    if (track.kind === 'video') return 'screen';
    if (slot === 'screen' || slot === 'screen-audio') {
      let el = this.screenAudio.get(peerId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        this.sink.append(el);
        sinkTo(el, this.outId);
        this.screenAudio.set(peerId, el);
      }
      el.srcObject = stream;
      el.play().catch(() => this.emit('blocked'));
      return 'screen-audio';
    }
    let r = this.remote.get(peerId);
    if (!r) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.peer = peerId;
      this.sink.append(audio);
      sinkTo(audio, this.outId);
      r = { audio, stream: null };
      this.remote.set(peerId, r);
    }
    r.stream = stream;
    r.audio.srcObject = stream;
    r.audio.play().catch(() => this.emit('blocked'));
    this._analyse(peerId, stream);
    return 'voice';
  }

  /** Try again to play every remote sound, after a click unlocked audio. */
  resume() {
    this.ctx?.resume?.();
    for (const r of this.remote.values()) r.audio.play().catch(() => {});
    for (const el of this.screenAudio.values()) el.play().catch(() => {});
  }

  _analyse(id, stream) {
    try {
      this.ctx ??= new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.analysers.set(id, { an, buf: new Uint8Array(an.fftSize) });
    } catch {
      // levels are a nicety; voice works without them
    }
  }

  /** Loudness from 0 to 1 for a peer id or 'self'. */
  level(id) {
    const a = this.analysers.get(id);
    if (!a) return 0;
    if (id === 'self' && (this.muted || !this.mic)) return 0;
    a.an.getByteTimeDomainData(a.buf);
    let sum = 0;
    for (const v of a.buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / a.buf.length) * 4);
  }

  async startScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] || null;
    if ('contentHint' in video) video.contentHint = 'motion';
    this.screen = { stream, video, audio };
    for (const link of this.links.values()) {
      link.setTrack('screen', video, stream);
      if (audio) link.setTrack('screen-audio', audio, stream);
    }
    video.addEventListener('ended', () => this.stopScreen());
    this.emit('change');
    return stream;
  }

  stopScreen() {
    if (!this.screen) return;
    for (const link of this.links.values()) {
      link.setTrack('screen', null);
      if (this.screen.audio) link.setTrack('screen-audio', null);
    }
    for (const t of this.screen.stream.getTracks()) t.stop();
    this.screen = null;
    this.emit('screen-ended');
    this.emit('change');
  }

  stopAll() {
    this.stopMic();
    this.stopCamera();
    this.stopScreen();
    this.stopMovie();
    for (const id of [...this.remote.keys(), ...this.screenAudio.keys()]) this.detach(id);
    this.links.clear();
  }
}

/** Route an element's sound to an output device, where the browser allows it. */
function sinkTo(el, id) {
  if (!el?.setSinkId || (el.sinkId || '') === (id || '')) return Promise.resolve();
  return el.setSinkId(id || '').catch(() => {});
}

/** Open a device by id, and fall back to the default one if it is gone. */
async function withFallback(id, open) {
  if (!id) return open('');
  try {
    return await open(id);
  } catch (err) {
    if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
    return open('');
  }
}
