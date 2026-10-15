import { describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.js';
import { ReplayGuard, deriveRendezvous, openMessage, sealMessage } from '../src/rendezvous.js';

const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
const FAST = 1000;

describe('rendezvous derivation', () => {
  it('gives both devices the same topic and key from the words', async () => {
    const a = await deriveRendezvous(words, FAST);
    const b = await deriveRendezvous(['ABANDON', ' ability', 'able', 'about', 'above', 'absent'], FAST);
    expect(a.topic).toBe(b.topic);
    expect(a.topic).toMatch(/^popcornpals\/v1\/[A-Za-z0-9_-]{22}$/);
    const sealed = await sealMessage(a, { k: 'join' });
    expect((await openMessage(b, sealed)).k).toBe('join');
  });

  it('gives other words another topic and a key that cannot open the message', async () => {
    const a = await deriveRendezvous(words, FAST);
    const c = await deriveRendezvous([...words.slice(0, 5), 'absorb'], FAST);
    expect(c.topic).not.toBe(a.topic);
    const sealed = await sealMessage(a, { k: 'offer', sdp: 'v=0' });
    await expect(openMessage(c, sealed)).rejects.toThrow(/Could not open/);
  });

  it('keeps the topic independent of the encryption key and hides the content', async () => {
    const a = await deriveRendezvous(words, FAST);
    const sealed = await sealMessage(a, { k: 'offer', sdp: 'a=fingerprint:sha-256 AA:BB' });
    expect(new TextDecoder().decode(sealed)).not.toContain('fingerprint');
    expect(a.topic).not.toContain('abandon');
    // The topic is authenticated: the same key on another topic does not open it.
    await expect(openMessage({ ...a, topic: 'popcornpals/v1/other' }, sealed)).rejects.toThrow();
  });

  it('rejects edited, truncated and foreign messages', async () => {
    const a = await deriveRendezvous(words, FAST);
    const sealed = await sealMessage(a, { k: 'answer' });
    const edited = sealed.slice();
    edited[20] ^= 1;
    await expect(openMessage(a, edited)).rejects.toThrow();
    await expect(openMessage(a, sealed.subarray(0, 20))).rejects.toThrow(/Not a popcornpals/);
    await expect(openMessage(a, utf8('hello world, this is not ours at all'))).rejects.toThrow();
  });

  it('adds a timestamp and a fresh nonce to every message', async () => {
    const a = await deriveRendezvous(words, FAST);
    const m1 = await openMessage(a, await sealMessage(a, { k: 'join' }, 1000));
    const m2 = await openMessage(a, await sealMessage(a, { k: 'join' }, 1000));
    expect(m1.ts).toBe(1000);
    expect(m1.n).not.toBe(m2.n);
  });
});

describe('ReplayGuard', () => {
  it('drops repeated nonces and stale or future messages', () => {
    let now = 1_000_000;
    const g = new ReplayGuard({ maxAge: 60_000, skew: 5_000, now: () => now });
    expect(g.accept({ ts: now, n: 'a' })).toBe(true);
    expect(g.accept({ ts: now, n: 'a' })).toBe(false);
    expect(g.accept({ ts: now - 61_000, n: 'b' })).toBe(false);
    expect(g.accept({ ts: now + 6_000, n: 'c' })).toBe(false);
    now += 30_000;
    expect(g.accept({ ts: now - 20_000, n: 'd' })).toBe(true);
  });
});
