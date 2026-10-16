// Copied from src/ by scripts/sync-core.mjs. Edit the file in src/ instead.
// Subtitles from .srt and .vtt files, as plain cues: { start, end, text } in
// seconds. Formatting tags are dropped; the room shows the text in its own style.

export const MAX_CUES = 5000;
export const MAX_TEXT = 400;

const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

/** Seconds from 00:01:02,500 or 01:02.500. NaN when it cannot be read. */
export function parseTime(text) {
  const m = TIME.exec(String(text));
  if (!m) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function clean(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/** Read an SRT or WebVTT file. Returns cues sorted by start time. */
export function parseSubtitles(input) {
  const text = String(input ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = parseTime(a);
    const end = parseTime(b);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = clean(lines.slice(at + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
    if (cues.length >= MAX_CUES) break;
  }
  return cues.sort((x, y) => x.start - y.start || x.end - y.end);
}

/** The text on screen at time t (several cues joined by a line break), or ''. */
export function cueText(cues, t) {
  if (!cues?.length || !Number.isFinite(t)) return '';
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo - 1; i >= 0 && out.length < 3; i--) {
    if (cues[i].end > t) out.unshift(cues[i].text);
    if (t - cues[i].start > 30) break;
  }
  return out.join('\n');
}

/** Validate cues that arrived from a peer. */
export function cleanCues(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list.slice(0, MAX_CUES)) {
    if (!c || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start || typeof c.text !== 'string') continue;
    const text = clean(c.text);
    if (text) out.push({ start: c.start, end: c.end, text });
  }
  return out.sort((x, y) => x.start - y.start);
}
