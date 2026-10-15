// Text chat records and reactions. Messages go to everyone directly; each
// member keeps the list. Reactions are small drawn icons, never characters.

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

/** A message record from a peer, or null when it is malformed. */
export function cleanMessage(msg, from) {
  const text = cleanText(msg?.text);
  if (!text || typeof msg.id !== 'string' || !/^[A-Za-z0-9_-]{4,32}$/.test(msg.id)) return null;
  return { id: msg.id, from, text, ts: Number.isFinite(msg.ts) ? msg.ts : Date.now(), reactions: {} };
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
