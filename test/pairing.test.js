import { describe, expect, it } from 'vitest';
import { fakeBroker } from './fake-broker.js';
import { CodeCreator, CodeJoiner } from '../src/pairing.js';
import { confirmWords, generateWords } from '../src/words.js';

const opts = (WebSocket) => ({ brokers: ['wss://a', 'wss://b'], WebSocket, iterations: 1000, knockEvery: 20, timeout: 200 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
};

describe('six word pairing over relays', () => {
  it('swaps the invite and the reply with nothing but the words', async () => {
    const WS = fakeBroker();
    const creator = new CodeCreator(Promise.resolve({ invite: { k: 'i', x: 'inv1' }, nonce: 'n1' }), opts(WS));
    const words = await creator.start();
    const joiner = new CodeJoiner(opts(WS));
    const offers = [];
    const answers = [];
    joiner.on('offer', (m) => offers.push(m));
    creator.on('answer', (m) => answers.push(m));
    await joiner.start([...words]);
    await until(() => offers.length === 1);
    expect(offers[0]).toMatchObject({ invite: { k: 'i', x: 'inv1' }, nonce: 'n1' });
    joiner.sendAnswer({ reply: { k: 'r', x: 'inv1' } });
    await until(() => answers.length === 1);
    await wait(150);
    expect(answers).toHaveLength(1);
    expect(answers[0].reply).toEqual({ k: 'r', x: 'inv1' });
    creator.stop();
    joiner.stop();
  });

  it('is single use: a second device with the same words gets nothing', async () => {
    const WS = fakeBroker();
    const creator = new CodeCreator(Promise.resolve({ invite: 1 }), opts(WS));
    const words = await creator.start();
    const first = new CodeJoiner(opts(WS));
    const second = new CodeJoiner(opts(WS));
    let firstGot = 0;
    let secondGot = 0;
    first.on('offer', () => firstGot++);
    second.on('offer', () => secondGot++);
    await first.start(words);
    await until(() => firstGot === 1);
    await second.start(words);
    await wait(200);
    expect(secondGot).toBe(0);
    for (const s of [creator, first, second]) s.stop();
  });

  it('times out with the wrong words and expires after its lifetime', async () => {
    const WS = fakeBroker();
    const creator = new CodeCreator(Promise.resolve({ invite: 1 }), { ...opts(WS), lifetime: 300 });
    let expired = false;
    creator.on('expired', () => (expired = true));
    const words = await creator.start();
    const other = generateWords();
    const joiner = new CodeJoiner({ ...opts(WS), joinTimeout: 150 });
    let timedOut = false;
    let got = false;
    joiner.on('timeout', () => (timedOut = true));
    joiner.on('offer', () => (got = true));
    await joiner.start(other.join(' ') === words.join(' ') ? generateWords() : other);
    await until(() => timedOut && expired);
    expect(got).toBe(false);
    expect(creator.stopped).toBe(true);
    joiner.stop();
  });

  it('derives the same confirmation words on both ends, different for another certificate', () => {
    const a = 'sha-256 AA:BB';
    const b = 'sha-256 CC:DD';
    expect(confirmWords(a, b, 'nonce')).toEqual(confirmWords(b, a, 'nonce'));
    expect(confirmWords(a, 'sha-256 EE:FF', 'nonce')).not.toEqual(confirmWords(a, b, 'nonce'));
    expect(confirmWords(a, b, 'other')).not.toEqual(confirmWords(a, b, 'nonce'));
  });
});
