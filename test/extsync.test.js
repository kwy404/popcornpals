import { describe, expect, it } from 'vitest';
import { PROTOCOL, PlayerSync, expectedPosition, message, pickMainVideo, readMessage, stateForPlayer } from '../src/extsync.js';
import { initialState } from '../src/sync.js';

/** A fake video element whose clock advances with the test clock. */
class FakeVideo {
  // Like a real element, every play(), pause(), seek and rate change queues one event.
  constructor(clock, { refuseSeek = false } = {}) {
    this.events = [];
    this.clock = clock;
    this._time = 0;
    this.paused = true;
    this.duration = 600;
    this.readyState = 4;
    this.refuseSeek = refuseSeek;
    this.last = clock.t;
  }
  _advance() {
    const t = this.clock.t;
    if (!this.paused) this._time += ((t - this.last) / 1000) * this.playbackRate;
    this.last = t;
  }
  get currentTime() {
    this._advance();
    return this._time;
  }
  set currentTime(v) {
    this._advance();
    if (!this.refuseSeek) this._time = v;
    this.events.push('seeking');
  }
  get playbackRate() {
    return this._rate ?? 1;
  }
  set playbackRate(r) {
    this._rate = r;
    this.events.push('ratechange');
  }
  play() {
    this._advance();
    if (this.paused) this.events.push('play');
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this._advance();
    if (!this.paused) this.events.push('pause');
    this.paused = true;
  }
  /** Deliver the queued events to the sync, as the browser would a moment later. */
  flush(sync) {
    const out = [];
    while (this.events.length) out.push(sync.onVideoEvent(this.events.shift()));
    return out.filter(Boolean);
  }
}

function setup(opts) {
  const clock = { t: 100000 };
  const video = new FakeVideo(clock, opts);
  const sent = [];
  const sync = new PlayerSync({ video, send: (m) => sent.push(m), now: () => clock.t, site: 'video.example' });
  return { clock, video, sent, sync };
}

describe('extension message protocol', () => {
  it('accepts well formed messages and cleans their fields', () => {
    expect(readMessage(message('state', { playing: true, pos: 12.5, rate: 1, at: 5, seq: 3 }))).toEqual({ pp: PROTOCOL, type: 'state', playing: true, pos: 12.5, rate: 1, at: 5, seq: 3, epoch: 0 });
    expect(readMessage(message('event', { action: 'seek', pos: 30, rate: 1 }))).toMatchObject({ action: 'seek', pos: 30 });
    expect(readMessage(message('status', { found: true, site: 'x'.repeat(300), seekable: false })).site).toHaveLength(100);
    expect(readMessage(message('room', { count: 9, people: [{ name: 'Ana', synced: 1 }] }))).toMatchObject({ count: 5, people: [{ name: 'Ana', synced: true }] });
    expect(readMessage(message('state', { playing: true, pos: 1, rate: 9, at: 1 })).rate).toBe(2);
  });

  it('refuses other versions, unknown types and broken fields', () => {
    expect(readMessage({ pp: 2, type: 'state' })).toBeNull();
    expect(readMessage({ pp: PROTOCOL, type: 'download' })).toBeNull();
    expect(readMessage(message('event', { action: 'record' }))).toBeNull();
    expect(readMessage(message('state', { pos: 'soon', rate: 1, at: 1 }))).toBeNull();
    expect(readMessage(null)).toBeNull();
  });

  it('restates the room on the local clock', () => {
    const room = { ...initialState(), src: { kind: 'ext' }, playing: true, pos: 10, at: 50000, rate: 1, seq: 4 };
    // the host clock is 2 s ahead of this browser
    const s = stateForPlayer(room, 52000, 50000);
    expect(s).toMatchObject({ type: 'state', playing: true, pos: 12, at: 50000, seq: 4 });
    expect(expectedPosition(s, 51500)).toBe(13.5);
    expect(expectedPosition({ ...s, playing: false }, 99999)).toBe(12);
  });

  it('picks the main video of a page', () => {
    const v = (w, h, o = {}) => ({ width: w, height: h, visible: true, paused: true, duration: 100, ...o });
    expect(pickMainVideo([v(300, 170), v(1280, 720), v(1920, 1080, { visible: false })])).toBe(1);
    expect(pickMainVideo([v(1280, 720), v(800, 450, { paused: false })])).toBe(1);
    expect(pickMainVideo([v(100, 50), v(640, 360, { visible: false })])).toBe(-1);
    expect(pickMainVideo([])).toBe(-1);
  });
});

describe('player sync in the page', () => {
  it('starts, follows and pauses with the room', () => {
    const { clock, video, sync } = setup();
    sync.onState(message('state', { playing: true, pos: 40, rate: 1, at: clock.t, seq: 1 }));
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBeCloseTo(40);
    clock.t += 5000;
    sync.tick();
    expect(video.currentTime).toBeCloseTo(45);
    sync.onState(message('state', { playing: false, pos: 45.2, rate: 1, at: clock.t, seq: 2 }));
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBeCloseTo(45.2);
  });

  it('seeks when the site player drifted too far, and leaves small drift alone', () => {
    const { clock, video, sync } = setup();
    sync.onState(message('state', { playing: true, pos: 0, rate: 1, at: clock.t, seq: 1 }));
    clock.t += 2000;
    video._time += 0.4;
    expect(sync.tick()).toBe('none');
    video._time += 3;
    clock.t += 2000;
    expect(sync.tick()).toBe('seek');
    expect(video.currentTime).toBeCloseTo(4);
  });

  it('rests at the end of the video instead of replaying it, and does not report the end as a pause', () => {
    const { clock, video, sync } = setup();
    video.duration = 30;
    sync.onState(message('state', { playing: true, pos: 29, rate: 1, at: clock.t, seq: 1 }));
    clock.t += 5000;
    video.pause();
    video.ended = true;
    expect(video.flush(sync)).toEqual([]);
    expect(sync.tick()).toBe('none');
    expect(video.paused).toBe(true);
  });

  it('follows the room speed', () => {
    const { clock, video, sync } = setup();
    sync.onState(message('state', { playing: true, pos: 0, rate: 1, at: clock.t, seq: 1 }));
    sync.onState(message('state', { playing: true, pos: 0, rate: 1.5, at: clock.t, seq: 2 }));
    expect(video.playbackRate).toBe(1.5);
  });

  it('reports what the person did, and not what the room did', () => {
    const { clock, video, sync, sent } = setup();
    sync.onState(message('state', { playing: true, pos: 10, rate: 1, at: clock.t, seq: 1 }));
    // the room's own seek and play are not reported, even if their events come late
    clock.t += 4000;
    expect(video.flush(sync)).toEqual([]);
    // the person pauses with the site's controls
    video.pause();
    expect(video.flush(sync)).toMatchObject([{ type: 'event', action: 'pause' }]);
    // ... and jumps ahead
    video.currentTime = 300;
    expect(video.flush(sync)).toMatchObject([{ action: 'seek', pos: 300 }]);
    video.playbackRate = 2;
    expect(video.flush(sync)).toMatchObject([{ action: 'rate', rate: 2 }]);
    expect(sent).toHaveLength(3);
  });

  it('ignores states older than the one it follows', () => {
    const { clock, video, sync } = setup();
    sync.onState(message('state', { playing: false, pos: 50, rate: 1, at: clock.t, seq: 5 }));
    sync.onState(message('state', { playing: false, pos: 0, rate: 1, at: clock.t, seq: 4 }));
    expect(video.currentTime).toBeCloseTo(50);
    sync.onState(message('state', { playing: false, pos: 7, rate: 1, at: clock.t, seq: 1, epoch: 1 }));
    expect(video.currentTime).toBeCloseTo(7);
  });

  it('takes a player that jumps back after an outside seek as refusing seeks, without reporting the jump', () => {
    const { clock, video, sync, sent } = setup();
    sync.onState(message('state', { playing: false, pos: 0, rate: 1, at: clock.t, seq: 1 }));
    video.flush(sync);
    sync.onState(message('state', { playing: false, pos: 80, rate: 1, at: clock.t, seq: 2 }));
    clock.t += 300;
    video.currentTime = 0; // the page puts it back
    expect(video.flush(sync)).toEqual([]);
    expect(sync.seekable).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'status', seekable: false });
  });

  it('also sees the undo when the event of our own seek arrives before the jump back, as in a browser', () => {
    const { clock, video, sync, sent } = setup();
    sync.onState(message('state', { playing: false, pos: 0, rate: 1, at: clock.t, seq: 1 }));
    video.flush(sync);
    sync.onState(message('state', { playing: false, pos: 80, rate: 1, at: clock.t, seq: 2 }));
    expect(video.flush(sync)).toEqual([]); // our own seek to 80
    clock.t += 300;
    video.currentTime = 0; // the page puts it back
    expect(video.flush(sync)).toEqual([]);
    expect(sync.seekable).toBe(false);
    expect(sent.some((m) => m.type === 'event')).toBe(false);
  });

  it('still reports a person seeking far from where the video was', () => {
    const { clock, video, sync } = setup();
    sync.onState(message('state', { playing: false, pos: 10, rate: 1, at: clock.t, seq: 1 }));
    video.flush(sync);
    clock.t += 500;
    video.currentTime = 60;
    expect(video.flush(sync)).toMatchObject([{ type: 'event', action: 'seek', pos: 60 }]);
    expect(sync.seekable).toBe(true);
  });

  it('falls back to play and pause only when the player refuses outside seeks', () => {
    const { clock, video, sync, sent } = setup({ refuseSeek: true });
    sync.onState(message('state', { playing: true, pos: 120, rate: 1, at: clock.t, seq: 1 }));
    expect(video.paused).toBe(false);
    clock.t += 2000;
    sync.tick(); // the first seek did not land: it tries once more
    expect(sync.seekable).toBe(true);
    clock.t += 2000;
    sync.tick();
    expect(sync.seekable).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'status', seekable: false, site: 'video.example' });
    // from now on it only plays and pauses
    clock.t += 3000;
    expect(sync.tick()).toBe('none');
    sync.onState(message('state', { playing: false, pos: 125, rate: 1, at: clock.t, seq: 2 }));
    expect(video.paused).toBe(true);
    video.flush(sync);
    video.currentTime = 10;
    expect(video.flush(sync)).toEqual([]);
  });
});
