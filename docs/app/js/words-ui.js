// Six word inputs that are kind to typing: paste a whole phrase, an invite
// text or an invite link into any box and it spreads one word per box (also
// when a phone keyboard inserts the clipboard with no paste event), space or
// Enter moves on, Backspace in an empty box goes back, and a word is
// finished as soon as it is a full list word. Wired once with event
// delegation, so it works for every word grid Voodoo renders, now or later.
// Values are written through input events, so v-model stays in step.

import { WORD_COUNT, normalizeWord, resolveWord, splitPhrase, suggestWords, wordsFromLink } from '../core/words.js';

function cellsOf(input) {
  const grid = input.closest('.word-grid');
  return grid ? [...grid.querySelectorAll('.word-field')] : [];
}

function set(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function mark(input) {
  const cell = input.closest('.word-cell');
  if (!cell) return;
  const raw = input.value.trim();
  const r = resolveWord(raw);
  cell.classList.toggle('is-ok', !!r);
  cell.classList.toggle('is-bad', !!raw && !r && raw.length >= 3);
}

export function wireWordInputs(root, { onComplete } = {}) {
  // how is 'typed' or 'spread': a spread phrase that fills every box joins at once.
  const done = (input, how = 'typed') => {
    const grid = input.closest('.word-grid');
    const all = cellsOf(input);
    if (all.length === WORD_COUNT && all.every((x) => resolveWord(x.value))) onComplete?.(grid?.dataset.prefix || '', how);
  };

  /**
   * Put a pasted phrase, invite text or invite link into the boxes, one word
   * per box, starting at the first box for a whole phrase. Returns false when
   * the text holds a single word, so it stays where it was typed.
   */
  const spread = (input, text) => {
    let parts = wordsFromLink(text) || splitPhrase(text);
    if (parts.length < 2) return false;
    // A share text with a label around the words: keep only the list words.
    if (parts.length > WORD_COUNT) {
      const known = parts.filter((p) => resolveWord(p)?.how === 'exact');
      if (known.length >= WORD_COUNT) parts = known.slice(-WORD_COUNT);
    }
    const all = cellsOf(input);
    const start = parts.length >= WORD_COUNT ? 0 : all.indexOf(input);
    set(input, '');
    parts.slice(0, WORD_COUNT - start).forEach((p, k) => set(all[start + k], normalizeWord(p)));
    all.forEach(mark);
    (all.find((x) => !resolveWord(x.value)) ?? all[WORD_COUNT - 1]).focus();
    done(input, 'spread');
    return true;
  };

  root.addEventListener('paste', (e) => {
    const input = e.target.closest?.('.word-field');
    if (input && spread(input, e.clipboardData?.getData('text') ?? '')) e.preventDefault();
  });

  root.addEventListener('input', (e) => {
    const input = e.target.closest?.('.word-field');
    if (!input || !e.isTrusted) return mark(input || e.target);
    // Phone keyboards often insert the clipboard with an input event and no paste event.
    if (/[^A-Za-zÀ-ɏ]/.test(input.value.trim()) && spread(input, input.value)) return;
    mark(input);
    if (e.inputType && !e.inputType.startsWith('insert')) return;
    const raw = normalizeWord(input.value);
    const r = resolveWord(raw);
    if (!r || r.how !== 'exact' || suggestWords(raw, 2).length !== 1) return;
    const all = cellsOf(input);
    const i = all.indexOf(input);
    if (i < all.length - 1) all[i + 1].focus();
    else done(input);
  });

  root.addEventListener('keydown', (e) => {
    const input = e.target.closest?.('.word-field');
    if (!input) return;
    const all = cellsOf(input);
    const i = all.indexOf(input);
    if ((e.key === ' ' || e.key === 'Enter') && input.value.trim() && i < all.length - 1) {
      e.preventDefault();
      all[i + 1].focus();
    } else if (e.key === 'Backspace' && !input.value && i > 0) {
      e.preventDefault();
      all[i - 1].focus();
    }
  });

  root.addEventListener(
    'blur',
    (e) => {
      const input = e.target.closest?.('.word-field');
      if (!input) return;
      const r = resolveWord(input.value);
      if (r && r.how !== 'exact') set(input, r.word);
      mark(input);
    },
    true,
  );
}
