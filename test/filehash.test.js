import { describe, expect, it } from 'vitest';
import { formatSize, quickHash, sampleRanges } from '../src/filehash.js';
import { Sha256 } from '../src/sha256.js';

const bytes = (n, seed = 1) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) out[i] = x = (x * 1103515245 + 12345) & 0xff;
  return out;
};

describe('quick file hash', () => {
  it('samples the start, the middle and the end of large files', () => {
    expect(sampleRanges(100, 10)).toEqual([
      [0, 10],
      [45, 55],
      [90, 100],
    ]);
    expect(sampleRanges(25, 10)).toEqual([[0, 25]]);
    expect(() => sampleRanges(-1)).toThrow();
  });

  it('gives the same hash for the same bytes and a different one for any sampled change', async () => {
    const data = bytes(4000);
    const a = await quickHash(new Blob([data]), 100);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await quickHash(new Blob([data.slice()]), 100)).toBe(a);
    for (const i of [0, 2000, 3999]) {
      const changed = data.slice();
      changed[i] ^= 1;
      expect(await quickHash(new Blob([changed]), 100)).not.toBe(a);
    }
    // same samples, different size: different hash
    expect(await quickHash(new Blob([data, new Uint8Array(1)]), 100)).not.toBe(a);
  });

  it('hashes small files completely', async () => {
    const data = bytes(50);
    const expected = new Sha256().update(new TextEncoder().encode('popcornpals quick v1|50|')).update(data).hex().slice(0, 32);
    expect(await quickHash(new Blob([data]))).toBe(expected);
  });

  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1500)).toBe('1.5 KB');
    expect(formatSize(734e6)).toBe('734 MB');
    expect(formatSize(1.4e9)).toBe('1.4 GB');
    expect(formatSize(-1)).toBe('');
  });
});
