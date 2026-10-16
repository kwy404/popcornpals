// Copied from src/ by scripts/sync-core.mjs. Edit the file in src/ instead.
// Random ids and connection fingerprints. WebRTC encrypts every connection
// with DTLS; the fingerprints of both DTLS certificates are what the six
// confirmation words are made from (see words.js).

const enc = new TextEncoder();

/** Random id as lowercase hex, 2 characters per byte. */
export function randomId(bytes = 8) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The DTLS certificate fingerprints announced in an SDP, normalized. */
export function sdpFingerprints(sdp) {
  const out = [];
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/.exec(line.trim());
    if (m) out.push(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  return [...new Set(out)];
}

/**
 * A short fingerprint of one connection, the same on both ends. It hashes the
 * DTLS fingerprints of both sides, so a relay that swapped certificates in the
 * middle would make the two screens show different values.
 */
export async function connectionFingerprint(localSdp, remoteSdp) {
  const all = [...sdpFingerprints(localSdp), ...sdpFingerprints(remoteSdp)].sort();
  if (all.length < 2) return '';
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(all.join('\n'))));
  const hex = Array.from(hash.subarray(0, 10), (x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  return hex.match(/.{4}/g).join(' ');
}
