// The three things the stage can show, behind one small interface the sync
// loop drives: time, rate, playing, buffering, play(), pause(), seek() and
// setRate(). Events: 'duration', 'ended', 'user' (someone used the player's
// own controls, YouTube only) and 'error'.

import { Emitter } from '../core/emitter.js';
import { EchoGuard, snapRate } from '../core/sync.js';
import { YT_RATES } from '../core/youtube.js';

/** A local video file in a plain video element, with our own controls. */
export class FilePlayer extends Emitter {
  constructor(video) {
    super();
    this.kind = 'file';
    this.video = video;
    this.url = null;
    this.rates = null;
    this._on = [
      ['loadedmetadata', () => Number.isFinite(video.duration) && this.emit('duration', video.duration)],
      ['durationchange', () => Number.isFinite(video.duration) && this.emit('duration', video.duration)],
      ['ended', () => this.emit('ended')],
      ['error', () => this.emit('error', video.error?.message || 'This file cannot be played in this browser.')],
    ];
    for (const [type, fn] of this._on) video.addEventListener(type, fn);
  }

  load(file) {
    this._revoke();
    this.url = URL.createObjectURL(file);
    this.video.src = this.url;
    this.video.load();
  }

  get ready() {
    return this.video.readyState >= 1;
  }

  get time() {
    return this.video.currentTime;
  }

  get rate() {
    return this.video.playbackRate;
  }

  get playing() {
    return !this.video.paused && !this.video.ended;
  }

  get buffering() {
    return this.video.seeking || (!this.video.paused && this.video.readyState < 3);
  }

  play() {
    return this.video.play();
  }

  pause() {
    this.video.pause();
  }

  seek(t) {
    this.video.currentTime = Math.max(0, t);
  }

  setRate(r) {
    this.video.playbackRate = r;
  }

  _revoke() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  destroy() {
    for (const [type, fn] of this._on) this.video.removeEventListener(type, fn);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this._revoke();
  }
}

/** A shared screen: a live stream, nothing to seek. */
export class ScreenView extends Emitter {
  constructor(video) {
    super();
    this.kind = 'screen';
    this.video = video;
  }

  show(stream, { muted = false } = {}) {
    this.video.srcObject = stream;
    this.video.muted = muted;
    this.video.play().catch(() => this.emit('blocked'));
  }

  destroy() {
    this.video.srcObject = null;
  }
}

let apiLoading = null;

/** Load the official YouTube IFrame Player API once. */
export function loadYouTubeApi() {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  apiLoading ??= new Promise((resolve, reject) => {
    const prev = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(globalThis.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      apiLoading = null;
      reject(new Error('The YouTube player could not be loaded. Check the connection.'));
    };
    document.head.append(s);
  });
  return apiLoading;
}

const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/**
 * A YouTube video in the official embedded player. People can use the
 * player's own controls too: those presses arrive as 'user' events and become
 * intents, while the presses the sync loop makes itself are recognized as echoes.
 */
export class YouTubePlayer extends Emitter {
  constructor(mount) {
    super();
    this.kind = 'yt';
    this.mount = mount;
    this.rates = YT_RATES;
    this.player = null;
    this.ready = false;
    this.state = -1;
    this.guard = new EchoGuard({ windowMs: 2500 });
  }

  async load(id, start = 0) {
    const YT = await loadYouTubeApi();
    const el = document.createElement('div');
    this.mount.replaceChildren(el);
    await new Promise((resolve) => {
      this.player = new YT.Player(el, {
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, start: Math.floor(start), origin: location.origin },
        events: {
          onReady: () => {
            this.ready = true;
            const d = this.player.getDuration?.();
            if (d > 0) this.emit('duration', d);
            resolve();
          },
          onStateChange: (e) => this._state(e.data),
          onError: (e) => this.emit('error', `YouTube could not play this video (error ${e.data}). The owner may not allow it in other sites.`),
        },
      });
    });
  }

  _state(s) {
    this.state = s;
    const now = Date.now();
    if (s === YT_STATE.PLAYING) {
      const d = this.player.getDuration?.();
      if (d > 0) this.emit('duration', d);
      if (!this.guard.isEcho('play', null, now)) this.emit('user', { action: 'play' });
    } else if (s === YT_STATE.PAUSED) {
      if (!this.guard.isEcho('pause', null, now)) this.emit('user', { action: 'pause' });
    } else if (s === YT_STATE.ENDED) {
      this.emit('ended');
    }
  }

  get time() {
    return this.player?.getCurrentTime?.() ?? 0;
  }

  get rate() {
    return this.player?.getPlaybackRate?.() ?? 1;
  }

  get playing() {
    return this.state === YT_STATE.PLAYING || this.state === YT_STATE.BUFFERING;
  }

  get buffering() {
    return this.state === YT_STATE.BUFFERING;
  }

  play() {
    this.guard.expect('play', null, Date.now());
    this.player?.playVideo?.();
    return Promise.resolve();
  }

  pause() {
    this.guard.expect('pause', null, Date.now());
    this.player?.pauseVideo?.();
  }

  seek(t) {
    this.player?.seekTo?.(Math.max(0, t), true);
  }

  setRate(r) {
    this.player?.setPlaybackRate?.(snapRate(r, YT_RATES));
  }

  destroy() {
    try {
      this.player?.destroy?.();
    } catch {
      // the iframe is already gone
    }
    this.mount.replaceChildren();
  }
}
