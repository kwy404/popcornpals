import { describe, expect, it } from 'vitest';
import { ClockSync, EchoGuard, SYNC, applyIntent, cleanSource, correction, hasEnded, initialState, isNewer, joinView, positionAt, snapRate, takeOver } from '../src/sync.js';
import { YT_RATES } from '../src/youtube.js';

const HASH = 'a'.repeat(32);
const FILE = { kind: 'file', hash: HASH, size: 1000, name: 'movie.webm', duration: 120 };
const YT = { kind: 'yt', id: 'abcdefghijk', title: 'A video' };

/** A host state with a file loaded, built through intents like the app does. */
function loaded(now = 1000, src = FILE) {
  const s = initialState({ host: 'host', now });
  return applyIntent(s, { action: 'load', by: 'host', base: s.seq, src }, { now }).state;
}

function run(state, intents) {
  let s = state;
  const results = [];
  for (const [intent, now] of intents) {
    const r = applyIntent(s, intent, { now });
    results.push(r.result);
    s = r.state;
  }
  return { state: s, results };
}

describe('positionAt', () => {
  it('extrapolates a playing state with its rate and stays put when paused', () => {
    const s = { ...loaded(), playing: true, pos: 10, at: 5000, rate: 1.5 };
    expect(positionAt(s, 5000)).toBe(10);
    expect(positionAt(s, 7000)).toBeCloseTo(13);
    expect(positionAt({ ...s, playing: false }, 9000)).toBe(10);
  });

  it('never goes below zero, never past the end, and ignores host times before the state', () => {
    const s = { ...loaded(), playing: true, pos: 119, at: 0, rate: 1 };
    expect(positionAt(s, 10000)).toBe(120);
    expect(positionAt({ ...s, pos: 5 }, -500)).toBe(5);
    expect(positionAt({ ...s, src: { ...FILE, duration: null }, pos: 500 }, 1000)).toBe(501);
    expect(positionAt(initialState(), 1000)).toBe(0);
    expect(hasEnded(s, 10000)).toBe(true);
    expect(hasEnded({ ...s, pos: 10 }, 0)).toBe(false);
  });
});

describe('drift correction math', () => {
  it('does nothing inside the soft band', () => {
    const r = correction({ expected: 30, actual: 30.05, playing: true, rate: 1, playerRate: 1 });
    expect(r.action).toBe('none');
    expect(r.drift).toBeCloseTo(0.05);
  });

  it('slows a player that is ahead and speeds up one that is behind, in proportion', () => {
    const ahead = correction({ expected: 30, actual: 30.2, playing: true, rate: 1, playerRate: 1 });
    expect(ahead.action).toBe('rate');
    // 0.2 s over a 2.5 s horizon: 8 percent slower
    expect(ahead.rate).toBeCloseTo(1 - 0.2 / SYNC.NUDGE_HORIZON, 3);
    const behind = correction({ expected: 30, actual: 29.9, playing: true, rate: 1, playerRate: 1 });
    expect(behind.rate).toBeCloseTo(1 + 0.1 / SYNC.NUDGE_HORIZON, 3);
  });

  it('caps the nudge and scales it with the room rate', () => {
    const r = correction({ expected: 30, actual: 30.6, playing: true, rate: 2, playerRate: 2 });
    expect(r.rate).toBeCloseTo(2 * (1 - SYNC.MAX_NUDGE), 3);
  });

  it('removes the drift: a simulated player converges and settles at the base rate', () => {
    let actual = 10.5;
    let playerRate = 1;
    let expected = 10;
    const dt = 0.25;
    for (let i = 0; i < 80; i++) {
      const r = correction({ expected, actual, playing: true, rate: 1, playerRate });
      if (r.action === 'rate') playerRate = r.rate;
      if (r.action === 'seek') actual = r.to;
      expected += dt;
      actual += dt * playerRate;
    }
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(SYNC.SOFT + 0.01);
    expect(playerRate).toBe(1);
  });

  it('seeks when the drift is too large to nudge away, earlier for files than for YouTube', () => {
    expect(correction({ expected: 30, actual: 31, playing: true })).toMatchObject({ action: 'seek', to: 30 });
    expect(correction({ expected: 30, actual: 31, playing: true, kind: 'yt' }).action).toBe('none');
    expect(correction({ expected: 30, actual: 31.5, playing: true, kind: 'yt' })).toMatchObject({ action: 'seek', to: 30 });
  });

  it('never nudges the YouTube player, it only has fixed rates', () => {
    expect(correction({ expected: 30, actual: 30.5, playing: true, kind: 'yt', rate: 1, playerRate: 1 }).action).toBe('none');
    expect(correction({ expected: 30, actual: 30, playing: true, kind: 'yt', rate: 1.5, playerRate: 1 })).toMatchObject({ action: 'rate', rate: 1.5 });
    expect(snapRate(1.1, YT_RATES)).toBe(1);
    expect(snapRate(1.4, YT_RATES)).toBe(1.5);
  });

  it('puts a paused player on the right frame and waits while buffering', () => {
    expect(correction({ expected: 42, actual: 42.1, playing: false }).action).toBe('none');
    expect(correction({ expected: 42, actual: 43, playing: false })).toMatchObject({ action: 'seek', to: 42 });
    expect(correction({ expected: 42, actual: 40, playing: true, buffering: true }).action).toBe('none');
    expect(correction({ expected: 42, actual: NaN, playing: true }).action).toBe('seek');
  });

  it('puts the rate back once the drift is gone', () => {
    expect(correction({ expected: 30, actual: 30.01, playing: true, rate: 1, playerRate: 0.95 })).toMatchObject({ action: 'rate', rate: 1 });
  });
});

describe('ClockSync', () => {
  it('finds the offset exactly when both legs take the same time', () => {
    const c = new ClockSync();
    // host clock is 5000 ms ahead, 40 ms each way
    c.add({ t0: 1000, h: 1040 + 5000, t1: 1080 });
    expect(c.offset).toBe(5000);
    expect(c.rtt).toBe(80);
    expect(c.hostNow(2000)).toBe(7000);
  });

  it('trusts the shortest round trip when the network is uneven', () => {
    const c = new ClockSync();
    c.add({ t0: 0, h: 300 + 2000, t1: 320 }); // slow, lopsided: estimate off by 140 ms
    c.add({ t0: 1000, h: 1010 + 2000, t1: 1020 }); // fast and even
    c.add({ t0: 2000, h: 2200 + 2000, t1: 2250 });
    expect(c.offset).toBe(2000);
    expect(c.add({ t0: 10, t1: 5, h: 0 })).toBeNull();
  });

  it('forgets old samples and starts again after reset', () => {
    const c = new ClockSync({ keep: 2 });
    c.add({ t0: 0, h: 5, t1: 10 });
    c.add({ t0: 0, h: 100, t1: 50 });
    c.add({ t0: 0, h: 200, t1: 60 });
    expect(c.samples).toHaveLength(2);
    expect(c.offset).toBe(75);
    c.reset();
    expect(c.ready).toBe(false);
    expect(c.offset).toBe(0);
  });
});

describe('host intents', () => {
  it('plays, pauses, seeks and changes the rate, counting every change', () => {
    const s0 = loaded(1000);
    const { state, results } = run(s0, [
      [{ action: 'play', by: 'bia', base: 1 }, 2000],
      [{ action: 'pause', by: 'host', base: 2 }, 12000],
      [{ action: 'seek', by: 'caio', base: 3, pos: 60 }, 15000],
      [{ action: 'rate', by: 'bia', base: 4, rate: 1.25 }, 16000],
    ]);
    expect(results).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(state).toMatchObject({ seq: 5, playing: false, pos: 60, rate: 1.25, by: 'bia' });
  });

  it('pauses on the frame the person saw when they pressed, not when the message arrived', () => {
    const playing = applyIntent(loaded(0), { action: 'play', by: 'host', base: 1 }, { now: 0 }).state;
    const r = applyIntent(playing, { action: 'pause', by: 'bia', base: 2, t: 10000 }, { now: 10150 });
    expect(r.state.pos).toBeCloseTo(10);
    // a pause cannot reach back more than MAX_PAUSE_REWIND_MS
    const late = applyIntent(playing, { action: 'pause', by: 'bia', base: 2, t: 1000 }, { now: 10000 });
    expect(late.state.pos).toBeCloseTo(8);
  });

  it('clamps seeks into the video and rates into the supported range', () => {
    const s = loaded();
    expect(applyIntent(s, { action: 'seek', by: 'x', base: 1, pos: 999 }, { now: 1 }).state.pos).toBe(120);
    expect(applyIntent(s, { action: 'seek', by: 'x', base: 1, pos: -5 }, { now: 1 }).state.pos).toBe(0);
    expect(applyIntent(s, { action: 'rate', by: 'x', base: 1, rate: 9 }, { now: 1 }).state.rate).toBe(2);
  });

  it('refuses nonsense and treats repeats as no-ops', () => {
    const s = loaded();
    expect(applyIntent(initialState(), { action: 'play', by: 'x' }, { now: 0 }).result).toBe('invalid');
    expect(applyIntent(s, { action: 'seek', by: 'x', pos: 'soon' }, { now: 0 }).result).toBe('invalid');
    expect(applyIntent(s, { action: 'dance', by: 'x' }, { now: 0 }).result).toBe('invalid');
    expect(applyIntent(s, { action: 'play' }, { now: 0 }).result).toBe('invalid');
    expect(applyIntent(s, { action: 'pause', by: 'x' }, { now: 0 }).result).toBe('noop');
    expect(applyIntent(s, { action: 'load', by: 'x', src: { kind: 'file', hash: 'nope' } }, { now: 0 }).result).toBe('invalid');
  });

  it('lets only the host lock, and refuses control from others while locked', () => {
    const s = loaded();
    expect(applyIntent(s, { action: 'lock', by: 'bia', lock: true }, { now: 0 }).result).toBe('invalid');
    const locked = applyIntent(s, { action: 'lock', by: 'host', base: 1, lock: true }, { now: 0 }).state;
    expect(locked.lock).toBe(true);
    for (const action of ['play', 'seek', 'load', 'next']) expect(applyIntent(locked, { action, by: 'bia', pos: 3, src: FILE }, { now: 10 }).result).toBe('locked');
    expect(applyIntent(locked, { action: 'play', by: 'host', base: 2 }, { now: 10 }).result).toBe('applied');
    // everyone can still suggest something for the queue
    expect(applyIntent(locked, { action: 'queue-add', by: 'bia', item: { id: 'q1', src: YT } }, { now: 10 }).result).toBe('applied');
  });

  it('learns the duration only from the host player', () => {
    const s = loaded(0, { ...FILE, duration: null });
    expect(applyIntent(s, { action: 'duration', by: 'bia', duration: 90 }, { now: 1 }).result).toBe('invalid');
    expect(applyIntent(s, { action: 'duration', by: 'host', duration: 90 }, { now: 1 }).state.src.duration).toBe(90);
  });
});

describe('conflict rules: two people press at once', () => {
  const playing = () => applyIntent(loaded(0), { action: 'play', by: 'host', base: 1 }, { now: 0 }).state;

  it('two plays at once: the first one wins, the second is a duplicate', () => {
    const s = loaded(0);
    const a = applyIntent(s, { action: 'play', by: 'ana', base: 1 }, { now: 5000 });
    const b = applyIntent(a.state, { action: 'play', by: 'bia', base: 1, pos: 0.3 }, { now: 5080 });
    expect(a.result).toBe('applied');
    expect(b.result).toBe('duplicate');
    expect(b.state).toBe(a.state);
    expect(b.state.pos).toBe(0);
  });

  it('a play against a pause at the same moment: the first one received wins', () => {
    const s = playing();
    const pause = applyIntent(s, { action: 'pause', by: 'ana', base: 2 }, { now: 4000 });
    const play = applyIntent(pause.state, { action: 'play', by: 'bia', base: 2 }, { now: 4100 });
    expect(pause.result).toBe('applied');
    expect(play.result).toBe('conflict');
    expect(play.state.playing).toBe(false);
  });

  it('two seeks at once: the first wins, a seek to the same spot is a duplicate', () => {
    const s = playing();
    const a = applyIntent(s, { action: 'seek', by: 'ana', base: 2, pos: 50 }, { now: 3000 });
    expect(applyIntent(a.state, { action: 'seek', by: 'bia', base: 2, pos: 80 }, { now: 3100 }).result).toBe('conflict');
    expect(applyIntent(a.state, { action: 'seek', by: 'bia', base: 2, pos: 50.4 }, { now: 3100 }).result).toBe('duplicate');
  });

  it('is decided by the host order alone, so every peer ends with the same state', () => {
    const s = loaded(0);
    const first = run(s, [
      [{ action: 'play', by: 'ana', base: 1 }, 100],
      [{ action: 'play', by: 'bia', base: 1 }, 150],
    ]).state;
    const other = run(s, [
      [{ action: 'play', by: 'bia', base: 1 }, 100],
      [{ action: 'play', by: 'ana', base: 1 }, 150],
    ]).state;
    expect({ ...first, by: null }).toEqual({ ...other, by: null });
  });

  it('applies a late intent once the window is over: it is a new decision', () => {
    const s = playing();
    const pause = applyIntent(s, { action: 'pause', by: 'ana', base: 2 }, { now: 4000 });
    const play = applyIntent(pause.state, { action: 'play', by: 'bia', base: 2 }, { now: 4000 + SYNC.CONFLICT_WINDOW_MS + 1 });
    expect(play.result).toBe('applied');
  });

  it('never treats the same person following up as a conflict', () => {
    const s = playing();
    const pause = applyIntent(s, { action: 'pause', by: 'ana', base: 2 }, { now: 4000 });
    expect(applyIntent(pause.state, { action: 'seek', by: 'ana', base: 2, pos: 10 }, { now: 4100 }).result).toBe('applied');
  });

  it('does not let queue edits collide with playback', () => {
    const s = playing();
    const pause = applyIntent(s, { action: 'pause', by: 'ana', base: 2 }, { now: 4000 });
    expect(applyIntent(pause.state, { action: 'queue-add', by: 'bia', base: 2, item: { id: 'q1', src: YT } }, { now: 4050 }).result).toBe('applied');
  });
});

describe('queue', () => {
  it('adds, moves, removes and plays the next item', () => {
    const s = loaded();
    const item = (id) => ({ id, src: { ...YT, title: id } });
    const { state } = run(s, [
      [{ action: 'queue-add', by: 'a', item: item('one') }, 1],
      [{ action: 'queue-add', by: 'b', item: item('two') }, 2],
      [{ action: 'queue-add', by: 'c', item: item('three') }, 3],
      [{ action: 'queue-move', by: 'a', itemId: 'three', to: 0 }, 4],
      [{ action: 'queue-remove', by: 'a', itemId: 'one' }, 5],
    ]);
    expect(state.queue.map((q) => q.id)).toEqual(['three', 'two']);
    expect(state.queue[1].by).toBe('b');
    const next = applyIntent(state, { action: 'next', by: 'host', autoplay: true }, { now: 9 }).state;
    expect(next.src.title).toBe('three');
    expect(next.playing).toBe(true);
    expect(next.queue.map((q) => q.id)).toEqual(['two']);
  });

  it('refuses duplicates, screen shares, bad ids and a full queue', () => {
    let s = loaded();
    s = applyIntent(s, { action: 'queue-add', by: 'a', item: { id: 'x', src: YT } }, { now: 1 }).state;
    expect(applyIntent(s, { action: 'queue-add', by: 'a', item: { id: 'x', src: YT } }, { now: 1 }).result).toBe('invalid');
    expect(applyIntent(s, { action: 'queue-add', by: 'a', item: { id: 'y', src: { kind: 'screen', id: 'abc' } } }, { now: 1 }).result).toBe('invalid');
    expect(applyIntent(s, { action: 'queue-add', by: 'a', item: { id: 'no spaces', src: YT } }, { now: 1 }).result).toBe('invalid');
    for (let i = 0; i < SYNC.MAX_QUEUE; i++) s = applyIntent(s, { action: 'queue-add', by: 'a', item: { id: `i${i}`, src: YT } }, { now: 1 }).state;
    expect(s.queue).toHaveLength(SYNC.MAX_QUEUE);
  });

  it('loading an item from the queue takes it off the queue', () => {
    let s = applyIntent(loaded(), { action: 'queue-add', by: 'a', item: { id: 'x', src: YT } }, { now: 1 }).state;
    s = applyIntent(s, { action: 'load', by: 'a', src: YT, itemId: 'x' }, { now: 2 }).state;
    expect(s.src.kind).toBe('yt');
    expect(s.queue).toEqual([]);
  });
});

describe('late joiner state', () => {
  it('lands where everyone else is, using its own clock offset', () => {
    // The host started playing at host time 10 000 from 5 s in.
    const hostState = { ...loaded(0), playing: true, pos: 5, at: 10000, seq: 7 };
    // The joiner's clock is 3 s behind the host.
    const clock = new ClockSync();
    clock.add({ t0: 20000, h: 23020, t1: 20040 });
    const view = joinView(initialState(), hostState, clock.hostNow(20040 + 1000), { fileHash: HASH });
    // host time is 24 040: 14.04 s after the start, so 19.04 s into the video
    expect(view.position).toBeCloseTo(19.04, 2);
    expect(view.playing).toBe(true);
    expect(view.needs).toBe('nothing');
  });

  it('says what the joiner must do first: pick the same file, load YouTube, or wait for the screen', () => {
    const s = loaded();
    expect(joinView(null, s, 0).needs).toBe('file');
    expect(joinView(null, s, 0, { fileHash: 'b'.repeat(32) }).needs).toBe('file');
    expect(joinView(null, { ...s, src: YT }, 0).needs).toBe('youtube');
    expect(joinView(null, { ...s, src: { kind: 'screen', id: 'x' } }, 0).needs).toBe('screen');
    expect(joinView(null, initialState(), 0).needs).toBe('nothing');
  });

  it('keeps the newest state when snapshots and updates arrive out of order', () => {
    const s5 = { ...loaded(), seq: 5, pos: 50 };
    const s6 = { ...s5, seq: 6, pos: 60 };
    expect(joinView(s6, s5, 0).state.pos).toBe(60);
    expect(joinView(s5, s6, 0).state.pos).toBe(60);
    expect(isNewer(s6, s5)).toBe(true);
    expect(isNewer(s5, s5)).toBe(false);
    expect(isNewer({ ...s5, epoch: 1, seq: 0 }, s6)).toBe(true);
    expect(isNewer(s5, null)).toBe(true);
  });

  it('carries on from the right spot when the host leaves and someone takes over', () => {
    const old = { ...loaded(0), playing: true, pos: 10, at: 1000, seq: 9, lock: true };
    // The new host's clock is 500 ms behind the old one; the old host's time is 6000.
    const next = takeOver(old, { host: 'bia', now: 5500, oldHostNow: 6000 });
    expect(next).toMatchObject({ host: 'bia', epoch: 1, seq: 10, pos: 15, at: 5500, playing: true, lock: false });
    expect(positionAt(next, 7500)).toBeCloseTo(17);
    expect(isNewer(next, old)).toBe(true);
  });
});

describe('cleanSource', () => {
  it('accepts YouTube ids, file fingerprints and screen shares, and nothing else', () => {
    expect(cleanSource(YT)).toMatchObject({ kind: 'yt', id: 'abcdefghijk' });
    expect(cleanSource(FILE)).toMatchObject({ kind: 'file', title: 'movie.webm', duration: 120 });
    expect(cleanSource({ kind: 'screen', id: 'abc' })).toMatchObject({ kind: 'screen' });
    expect(cleanSource({ kind: 'yt', id: 'short' })).toBeNull();
    expect(cleanSource({ kind: 'url', url: 'https://example.com/v.mp4' })).toBeNull();
    expect(cleanSource(null)).toBeNull();
  });
});

describe('EchoGuard', () => {
  it('swallows the events the app caused and reports what a person did', () => {
    const g = new EchoGuard({ windowMs: 1000 });
    g.expect('play', null, 0);
    g.expect('seek', 30, 0);
    expect(g.isEcho('play', null, 100)).toBe(true);
    expect(g.isEcho('play', null, 200)).toBe(false);
    expect(g.isEcho('seek', 30.2, 300)).toBe(true);
    g.expect('seek', 30, 400);
    expect(g.isEcho('seek', 55, 500)).toBe(false);
    expect(g.isEcho('seek', 30, 2000)).toBe(false);
    g.expect('rate', 1.25, 0);
    expect(g.isEcho('rate', 1, 10)).toBe(false);
    expect(g.isEcho('rate', 1.25, 10)).toBe(true);
  });
});
