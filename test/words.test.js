import { wordlist as reference } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';
import { WORDLIST } from '../src/wordlist.js';
import { ENTROPY_BITS, confirmWords, generateWords, indicesOf, normalizeWord, phraseOf, resolvePhrase, resolveWord, splitPhrase, suggestWords, wordsFromBytes, wordsFromLink, wordsLink } from '../src/words.js';

describe('BIP39 wordlist', () => {
  it('is the exact English list: 2048 words, unique by their first four letters', () => {
    expect(WORDLIST.length).toBe(2048);
    expect([...WORDLIST]).toEqual([...reference]);
    expect(new Set(WORDLIST.map((w) => w.slice(0, 4))).size).toBe(2048);
    expect(Object.isFrozen(WORDLIST)).toBe(true);
  });
});

describe('word generation', () => {
  it('turns 66 bits into six words, 11 bits each, most significant bit first', () => {
    expect(ENTROPY_BITS).toBe(66);
    expect(wordsFromBytes(new Uint8Array(9))).toEqual(Array(6).fill('abandon'));
    expect(wordsFromBytes(new Uint8Array(9).fill(0xff))).toEqual(Array(6).fill('zoo'));
    // 0b00000000001 then zeros: the second word of the list first.
    const b = new Uint8Array(9);
    b[1] = 0b00100000;
    expect(wordsFromBytes(b)[0]).toBe('ability');
    // The last word uses bits 55 to 65.
    const c = new Uint8Array(9);
    c[8] = 0b01000000;
    expect(indicesOf(wordsFromBytes(c))).toEqual([0, 0, 0, 0, 0, 1]);
    expect(() => wordsFromBytes(new Uint8Array(8))).toThrow();
  });

  it('draws from crypto.getRandomValues and spreads over the whole list', () => {
    let asked = 0;
    const words = generateWords((n) => {
      asked = n;
      return crypto.getRandomValues(new Uint8Array(n));
    });
    expect(asked).toBe(9);
    expect(words).toHaveLength(6);
    const seen = new Set();
    for (let i = 0; i < 400; i++) for (const w of generateWords()) seen.add(w);
    expect(seen.size).toBeGreaterThan(1300); // 2400 draws over 2048 words: about 1414 distinct expected
    expect(generateWords()).not.toEqual(generateWords());
  });
});

describe('typing the words', () => {
  it('normalizes case, accents and punctuation', () => {
    expect(normalizeWord('  Abandon! ')).toBe('abandon');
    expect(normalizeWord('caf\u00e9')).toBe('cafe');
    expect(normalizeWord(null)).toBe('');
  });

  it('accepts the first four letters and fixes a single typo', () => {
    expect(resolveWord('abandon')).toEqual({ word: 'abandon', how: 'exact' });
    expect(resolveWord('aban')).toEqual({ word: 'abandon', how: 'prefix' });
    expect(resolveWord('ABANDONN')).toEqual({ word: 'abandon', how: 'prefix' });
    expect(resolveWord('zoo')).toEqual({ word: 'zoo', how: 'exact' });
    expect(resolveWord('abadnon')).toEqual({ word: 'abandon', how: 'typo' }); // swapped letters
    expect(resolveWord('xylophone')).toBeNull();
    expect(resolveWord('ab')).toBeNull(); // too short to be sure
    expect(resolveWord('')).toBeNull();
  });

  it('suggests words for autocomplete', () => {
    expect(suggestWords('zo')).toEqual(['zone', 'zoo']);
    expect(suggestWords('a', 3)).toEqual(['abandon', 'ability', 'able']);
    expect(suggestWords('')).toEqual([]);
  });

  it('splits and resolves a pasted phrase', () => {
    expect(splitPhrase(' Abandon, ability\nable-about  above.absent ')).toEqual(['Abandon', 'ability', 'able', 'about', 'above', 'absent']);
    const ok = resolvePhrase('aban abil able abou abov abse');
    expect(ok.ok).toBe(true);
    expect(phraseOf(ok.words)).toBe('abandon ability able about above absent');
    const bad = resolvePhrase(['abandon', 'qqqq', 'able', 'about', 'above']);
    expect(bad.ok).toBe(false);
    expect(bad.missing).toEqual([1, 5]);
  });
});

describe('confirmation words', () => {
  const a = 'sha-256 7d271e852af65d0c980375ab1e83af0e8891e62ef54c5c69d02d09d231dc9554';
  const b = 'sha-256 195cd9986a3ac7f82a6c61debc255f837f1e5093d7d83053d756f7eca7f274e1';
  const evil = 'sha-256 00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

  it('are the same on both devices', () => {
    expect(confirmWords(a, b, 'nonce1')).toEqual(confirmWords(b, a, 'nonce1'));
    expect(confirmWords(a, b, 'nonce1')).toHaveLength(6);
  });

  it('change with a different peer certificate or a different session nonce', () => {
    const base = confirmWords(a, b, 'nonce1');
    expect(confirmWords(a, evil, 'nonce1')).not.toEqual(base);
    expect(confirmWords(a, b, 'nonce2')).not.toEqual(base);
    expect(() => confirmWords(a, null, 'n')).toThrow();
  });
});

describe('pairing link', () => {
  it('carries the words in the fragment and keeps the QR small', async () => {
    const { encodeQR: encodeQr } = await import('../src/qr.js');
    const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
    const link = wordsLink('https://kwy404.github.io/popcornpals/app/#old', words);
    expect(link).toBe('https://kwy404.github.io/popcornpals/app/#join=abandon-ability-able-about-above-absent');
    expect(wordsFromLink('#join=abandon-ability-able-about-above-absent')).toEqual(words);
    expect(wordsFromLink('#join=')).toBeNull();
    expect(wordsFromLink(link)).toEqual(words);
    expect(wordsFromLink('nothing here')).toBeNull();
    // The longest possible words still fit a small, easy to scan code.
    const longest = [...WORDLIST].sort((a, b) => b.length - a.length).slice(0, 6);
    expect(encodeQr(wordsLink('https://kwy404.github.io/popcornpals/app/', longest), { ecl: 'M' }).version).toBeLessThanOrEqual(6);
  });
});
