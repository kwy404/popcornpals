// Names and the quiet colors that tell members apart.

export const COLORS = Object.freeze(['#B98A92', '#8FA3B8', '#A9A07E', '#8DAE9F', '#A895B8', '#B8A08D']);

/** A display name: trimmed, single spaced, 1 to 24 characters. */
export function cleanName(name, fallback = 'Guest') {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return s || fallback;
}

/** A stable color for an id. */
export function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Two letters for an avatar. */
export function initials(name) {
  const parts = cleanName(name).split(' ');
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || '')).toUpperCase();
}
