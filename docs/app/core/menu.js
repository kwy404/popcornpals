// Copied from src/ by scripts/sync-core.mjs. Edit the file in src/ instead.
// The pure parts of the context menu: where a menu and its submenus go so
// they stay inside the viewport, which item the arrow keys and Home or End
// move to, and type-ahead by the first letters of an item. The DOM side
// lives in docs/app/js/menu.js.

export const MENU_MARGIN = 8;

/**
 * Where a menu of size w x h opens for a point (x, y) in a viewport of vw x vh.
 * It opens down and to the right of the point, flips left or up when it would
 * cross an edge, and is finally clamped inside the margins. A menu taller
 * than the viewport gets a maxHeight and scrolls.
 * Returns { left, top, maxHeight, flipX, flipY }.
 */
export function placeMenu({ x, y, w, h, vw, vh, margin = MENU_MARGIN }) {
  const room = vh - margin * 2;
  const maxHeight = h > room ? room : null;
  const height = Math.min(h, room);
  let left = x;
  let top = y;
  const flipX = x + w > vw - margin;
  const flipY = y + height > vh - margin;
  if (flipX) left = x - w;
  if (flipY) top = y - height;
  left = clamp(left, margin, vw - margin - w);
  top = clamp(top, margin, vh - margin - height);
  return { left, top, maxHeight, flipX, flipY };
}

/**
 * Where a submenu of size w x h goes next to its item: to the right of the
 * parent menu, or to its left when the right side has no room, lined up with
 * the item and kept inside the viewport.
 * item and parent are rectangles { left, top, right, bottom }.
 * Returns { left, top, maxHeight, side } with side 'right' or 'left'.
 */
export function placeSubmenu({ item, parent, w, h, vw, vh, margin = MENU_MARGIN, overlap = 4, inset = 6 }) {
  const room = vh - margin * 2;
  const height = Math.min(h, room);
  let side = 'right';
  let left = parent.right - overlap;
  if (left + w > vw - margin) {
    const leftSide = parent.left - w + overlap;
    // Take whichever side shows more of the submenu.
    if (leftSide >= margin || parent.left > vw - parent.right) {
      side = 'left';
      left = leftSide;
    }
  }
  left = clamp(left, margin, vw - margin - w);
  const top = clamp(item.top - inset, margin, vh - margin - height);
  return { left, top, maxHeight: h > room ? room : null, side };
}

/**
 * The next item index for a key, or null when the key does not move.
 * count: the number of items; at: the focused index (-1 for none).
 */
export function moveIndex(key, at, count) {
  if (!count) return null;
  if (key === 'ArrowDown') return at < 0 ? 0 : (at + 1) % count;
  if (key === 'ArrowUp') return at < 0 ? count - 1 : (at - 1 + count) % count;
  if (key === 'Home' || key === 'PageUp') return 0;
  if (key === 'End' || key === 'PageDown') return count - 1;
  return null;
}

/**
 * Type-ahead: the first item after `at` whose label starts with the typed
 * text (case and accents ignored), wrapping around. Returns the index or -1.
 */
export function typeahead(labels, at, text) {
  const want = fold(text);
  if (!want) return -1;
  const n = labels.length;
  // A repeated single letter cycles through the items with that letter.
  const start = want.length === 1 ? at + 1 : Math.max(at, 0);
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (fold(labels[i]).startsWith(want)) return i;
  }
  return -1;
}

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}
