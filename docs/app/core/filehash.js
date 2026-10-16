// Copied from src/ by scripts/sync-core.mjs. Edit the file in src/ instead.
// A quick fingerprint of a video file, so everyone in the room can check they
// picked the same one without reading gigabytes. It hashes the size and three
// 1 MiB samples (start, middle and end) with SHA-256. Two different files that
// share size and all three samples would collide, which does not happen with
// real video files; for a guarantee you would need to hash every byte.

import { Sha256 } from './sha256.js';
import { utf8 } from './bytes.js';

export const SAMPLE_BYTES = 1024 * 1024;

/** Byte ranges [start, end) that are sampled for a file of this size. */
export function sampleRanges(size, sample = SAMPLE_BYTES) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('size must be a non negative integer');
  if (size <= sample * 3) return [[0, size]];
  const mid = Math.floor(size / 2 - sample / 2);
  return [
    [0, sample],
    [mid, mid + sample],
    [size - sample, size],
  ];
}

/** The quick hash of a Blob or File: 32 lowercase hex characters. */
export async function quickHash(blob, sample = SAMPLE_BYTES) {
  const h = new Sha256().update(utf8(`popcornpals quick v1|${blob.size}|`));
  for (const [start, end] of sampleRanges(blob.size, sample)) {
    h.update(new Uint8Array(await blob.slice(start, end).arrayBuffer()));
  }
  return h.hex().slice(0, 32);
}

/** Human readable size: 734 MB, 1.4 GB. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
