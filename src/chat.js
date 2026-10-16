// Text chat records, replies, reactions and video time links. Messages go to
// everyone directly; each member keeps the list. Reactions are small drawn
// icons, never characters. A message remembers where the video was when it
// was sent (vt), and times written in the text ("look at 12:34") become links.

export const REACTIONS = Object.freeze(['popcorn', 'heart', 'laugh', 'wow', 'clap', 'sleepy']);
export const MAX_TEXT = 500;
export const MAX_MESSAGES = 300;

/** Trim, drop control characters and cap the length. Returns '' when nothing is left. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

const ID = /^[A-Za-z0-9_-]{4,32}$/;

/** A message record from a peer, or null when it is malformed. re: the id it replies to; vt: the video time when sent. */
export function cleanMessage(msg, from) {
  const text = cleanText(msg?.text);
  if (!text || typeof msg.id !== 'string' || !ID.test(msg.id)) return null;
  const out = { id: msg.id, from, text, ts: Number.isFinite(msg.ts) ? msg.ts : Date.now(), reactions: {} };
  if (typeof msg.re === 'string' && ID.test(msg.re) && msg.re !== msg.id) out.re = msg.re;
  if (Number.isFinite(msg.vt) && msg.vt >= 0 && msg.vt < 1e6) out.vt = Math.round(msg.vt * 10) / 10;
  return out;
}

/** 75 as 1:15, 3725 as 1:02:05. */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Split a message into text and video times: "at 1:02:05 and 12:34" gives
 * [{ text: 'at ' }, { time: 3725, label: '1:02:05' }, { text: ' and ' }, { time: 754, label: '12:34' }].
 */
export function splitTimes(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(/(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/g)) {
    const [label, h, min, sec] = m;
    if (Number(sec) > 59 || (h && Number(min) > 59)) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ time: Number(h || 0) * 3600 + Number(min) * 60 + Number(sec), label });
    last = m.index + label.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Toggle one person's reaction on a message. Returns true when it changed anything. */
export function toggleReaction(message, reaction, who, on) {
  if (!message || !REACTIONS.includes(reaction) || !who) return false;
  const list = message.reactions[reaction] || [];
  const has = list.includes(who);
  const want = on ?? !has;
  if (want === has) return false;
  message.reactions[reaction] = want ? [...list, who] : list.filter((w) => w !== who);
  if (!message.reactions[reaction].length) delete message.reactions[reaction];
  return true;
}

/** Add a message to a list, keeping order by time and the newest MAX_MESSAGES. */
export function addMessage(list, message) {
  if (!message || list.some((m) => m.id === message.id)) return false;
  list.push(message);
  list.sort((a, b) => a.ts - b.ts);
  if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  return true;
}

/** At most max events per window, per sender. */
export class RateLimit {
  constructor({ max = 8, windowMs = 4000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  allow(key) {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => x > t - this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }
}
