import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { alignmentPositions, byteCapacity, encodeQR, formatBits, qrPath, qrSvg, rsRemainder } from '../src/qr.js';

// Rasterize a QR code to RGBA pixels and read it back with an independent decoder.
function decode(qr, scale = 4, margin = 4) {
  const side = (qr.size + margin * 2) * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  const out = jsQR(px, side, side, { inversionAttempts: 'dontInvert' });
  return out && out.data;
}

describe('QR tables', () => {
  it('matches the byte capacities of the spec', () => {
    expect(byteCapacity(1, 'L')).toBe(17);
    expect(byteCapacity(1, 'M')).toBe(14);
    expect(byteCapacity(1, 'Q')).toBe(11);
    expect(byteCapacity(1, 'H')).toBe(7);
    expect(byteCapacity(2, 'L')).toBe(32);
    expect(byteCapacity(10, 'L')).toBe(271);
    expect(byteCapacity(10, 'H')).toBe(119);
    expect(byteCapacity(25, 'M')).toBe(997);
    expect(byteCapacity(40, 'L')).toBe(2953);
    expect(byteCapacity(40, 'M')).toBe(2331);
    expect(byteCapacity(40, 'Q')).toBe(1663);
    expect(byteCapacity(40, 'H')).toBe(1273);
  });

  it('places alignment patterns where the spec does', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });

  it('computes format bits with BCH and the fixed mask', () => {
    // Values from the format information table of the spec.
    expect(formatBits('M', 0)).toBe(0b101010000010010);
    expect(formatBits('L', 0)).toBe(0b111011111000100);
    expect(formatBits('H', 7)).toBe(0b000100000111011);
  });

  it('computes Reed-Solomon remainders', () => {
    // "HELLO WORLD" 1-M data codewords and their known error correction bytes.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
});

describe('encodeQR', () => {
  it('round trips short text through a real decoder', () => {
    const qr = encodeQR('popcornpals');
    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
    expect(decode(qr)).toBe('popcornpals');
  });

  it('round trips every mask and level', () => {
    for (const ecl of ['L', 'M', 'Q', 'H']) {
      for (let mask = 0; mask < 8; mask++) {
        const text = `mask ${mask} level ${ecl}`;
        expect(decode(encodeQR(text, { ecl, mask, boost: false }))).toBe(text);
      }
    }
  });

  it('round trips invite sized links across many versions', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const length of [40, 120, 300, 520, 800, 1100, 1500]) {
      let s = 'https://kwy404.github.io/popcornpals/app/#i=';
      for (let i = 0; s.length < length; i++) s += alphabet[(i * 7 + length) % 64];
      const qr = encodeQR(s, { ecl: 'L' });
      expect(qr.size).toBe(qr.version * 4 + 17);
      expect(decode(qr, 3)).toBe(s);
    }
  });

  it('encodes UTF-8 bytes', () => {
    const text = 'café São Paulo';
    const qr = encodeQR(text);
    expect(qr.modules.length).toBe(qr.size);
    expect(decode(qr)).toBe(text);
  });

  it('boosts the error correction level when the version has room', () => {
    expect(encodeQR('hi', { ecl: 'L' }).ecl).toBe('H');
    expect(encodeQR('hi', { ecl: 'L', boost: false }).ecl).toBe('L');
  });

  it('picks the lowest penalty mask by default', () => {
    const qr = encodeQR('mask choice');
    expect(qr.mask).toBeGreaterThanOrEqual(0);
    expect(qr.mask).toBeLessThan(8);
  });

  it('throws for data that cannot fit', () => {
    expect(() => encodeQR(new Uint8Array(3000), { ecl: 'L' })).toThrow(RangeError);
    expect(() => encodeQR('x', { ecl: 'Z' })).toThrow(TypeError);
    expect(() => encodeQR('x'.repeat(100), { maxVersion: 2 })).toThrow(RangeError);
  });
});

describe('QR output', () => {
  it('builds path data and a standalone SVG', () => {
    const qr = encodeQR('svg');
    const d = qrPath(qr, 2);
    expect(d.startsWith('M2 2h7v1h-7z')).toBe(true);
    const svg = qrSvg(qr, { title: 'Invite <code>', dark: '#111' });
    expect(svg).toContain(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`);
    expect(svg).toContain('<title>Invite code</title>');
    expect(svg).toContain('fill="#111"');
  });
});
