// YouTube videos play in the official embedded player (the IFrame Player
// API), which every member loads from YouTube itself. This module only reads
// links: it finds the 11 character video id and an optional start time.

export const YT_RATES = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/** Seconds from a start time like 90, 90s, 1m30s or 1h2m3s. Returns 0 when it cannot be read. */
export function parseStart(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.floor(Number(s));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || !s) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/**
 * Read a YouTube link (watch, short link, shorts, live, embed) or a bare
 * video id. Returns { id, start } or null.
 */
export function parseYouTube(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (ID.test(text)) return { id: text, start: 0 };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !HOSTS.has(url.hostname.toLowerCase())) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = parts[0];
  else if (parts[0] === 'watch') id = url.searchParams.get('v');
  else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
  if (!id || !ID.test(id)) return null;
  const start = parseStart(url.searchParams.get('t') ?? url.searchParams.get('start') ?? (url.hash.startsWith('#t=') ? url.hash.slice(3) : ''));
  return { id, start };
}

/** The thumbnail YouTube serves for a video id. */
export const thumbnailUrl = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
