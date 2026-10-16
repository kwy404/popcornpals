// One context menu for the whole app: a dark menu with role="menu" and
// menuitem, menuitemcheckbox or menuitemradio items, submenus, and the
// keyboard of a desktop menu (arrows, Home, End, Enter, Space, Escape, Tab
// and type-ahead). It stays inside the viewport (see core/menu.js).
//
// bindContextMenu() opens it by right click, by a long press on touch screens
// and by the Menu key or Shift+F10 on the focused element.
//
// An item: { label, icon, run, items, checked, radio, disabled, hint, id }
//   items: a submenu; checked: true or false makes it a checkbox (or a radio
//   with radio: true); disabled items can be focused but do nothing.
//   { separator: true } draws a line.

import { moveIndex, placeMenu, placeSubmenu, typeahead } from '../core/menu.js';

const SVG = 'http://www.w3.org/2000/svg';
const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;
const HOVER_OPEN_MS = 160;
let uid = 0;

function icon(name, cls = 'ic') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}

export class Menu {
  constructor() {
    this.levels = []; // [{ el, items, buttons, depth, parentBtn }]
    this.from = null;
    this.typed = '';
    this.typedAt = 0;
    this.hoverTimer = 0;
    this._outside = (e) => {
      if (!this.levels.some((l) => l.el.contains(e.target))) this.close({ restore: false });
    };
    this._dismiss = (e) => {
      if (e?.type === 'scroll' && this.levels.some((l) => l.el.contains(e.target))) return;
      this.close({ restore: false });
    };
  }

  get isOpen() {
    return this.levels.length > 0;
  }

  /**
   * Open at a point. from: the element focus goes back to; focusFirst: put
   * focus on the first item (keyboard), or on the menu itself (pointer).
   */
  open(items, { x, y, label = '', from = null, focusFirst = false } = {}) {
    this.close({ restore: false });
    this.from = from || document.activeElement;
    const level = this._render(items, label, 0);
    const r = level.el.getBoundingClientRect();
    const p = placeMenu({ x, y, w: r.width, h: r.height, vw: document.documentElement.clientWidth, vh: innerHeight });
    this._put(level.el, p);
    document.addEventListener('pointerdown', this._outside, true);
    document.addEventListener('scroll', this._dismiss, true);
    addEventListener('resize', this._dismiss);
    addEventListener('blur', this._dismiss);
    if (focusFirst) this._focus(level, 0);
    else level.el.focus({ preventScroll: true });
    return level.el;
  }

  /** Close every level; focus goes back to where it came from. */
  close({ restore = true } = {}) {
    if (!this.levels.length) return;
    clearTimeout(this.hoverTimer);
    this._closeFrom(0);
    document.removeEventListener('pointerdown', this._outside, true);
    document.removeEventListener('scroll', this._dismiss, true);
    removeEventListener('resize', this._dismiss);
    removeEventListener('blur', this._dismiss);
    const from = this.from;
    this.from = null;
    if (restore && from?.isConnected) from.focus({ preventScroll: true });
  }

  _render(items, label, depth) {
    const el = document.createElement('div');
    el.className = 'ctx-menu';
    el.id = `ctx-menu-${++uid}`;
    el.setAttribute('role', 'menu');
    el.tabIndex = -1;
    if (label) el.setAttribute('aria-label', label);
    el.dataset.depth = String(depth);
    const level = { el, items: [], buttons: [], depth, parentBtn: null };
    for (const it of items) {
      if (!it) continue;
      if (it.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        sep.setAttribute('role', 'separator');
        el.append(sep);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item';
      b.tabIndex = -1;
      const checkable = typeof it.checked === 'boolean';
      b.setAttribute('role', checkable ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem');
      if (checkable) b.setAttribute('aria-checked', String(it.checked));
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      if (it.id) b.dataset.item = it.id;
      if (it.items) {
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
      }
      const lead = document.createElement('span');
      lead.className = 'ctx-lead';
      if (checkable) lead.append(icon('check', `ic ctx-check${it.checked ? '' : ' is-off'}`));
      else if (it.icon) lead.append(icon(it.icon));
      const text = document.createElement('span');
      text.className = 'ctx-label';
      text.textContent = it.label;
      const tail = document.createElement('span');
      tail.className = 'ctx-tail';
      if (it.items) tail.append(icon('chevron', 'ic ctx-chev'));
      else if (it.hint) tail.textContent = it.hint;
      b.append(lead, text, tail);
      const i = level.buttons.length;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this._activate(level, i, { keyboard: e.detail === 0 });
      });
      b.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch') return;
        b.focus({ preventScroll: true });
        clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
          if (!b.isConnected) return;
          if (it.items && !it.disabled) this._openSub(level, i, false);
          else this._closeFrom(depth + 1);
        }, HOVER_OPEN_MS);
      });
      level.items.push(it);
      level.buttons.push(b);
      el.append(b);
    }
    el.addEventListener('keydown', (e) => this._key(e, level));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // In fullscreen only the fullscreen element shows, so the menu goes inside it.
    (document.fullscreenElement || document.body).append(el);
    this.levels.push(level);
    return level;
  }

  _put(el, p) {
    el.style.left = `${Math.round(p.left)}px`;
    el.style.top = `${Math.round(p.top)}px`;
    if (p.maxHeight) el.style.maxHeight = `${Math.floor(p.maxHeight)}px`;
    el.classList.add('is-placed');
  }

  _focus(level, i) {
    const b = level.buttons[i];
    if (!b) return;
    b.focus({ preventScroll: false });
  }

  _closeFrom(depth) {
    while (this.levels.length > depth) {
      const level = this.levels.pop();
      level.parentBtn?.setAttribute('aria-expanded', 'false');
      level.parentBtn?.removeAttribute('aria-controls');
      level.el.remove();
    }
  }

  _openSub(level, i, focus) {
    const it = level.items[i];
    const btn = level.buttons[i];
    if (!it?.items || it.disabled) return;
    const open = this.levels[level.depth + 1];
    if (open?.parentBtn === btn) {
      if (focus) this._focus(open, 0);
      return;
    }
    this._closeFrom(level.depth + 1);
    const sub = this._render(it.items, it.label, level.depth + 1);
    sub.parentBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-controls', sub.el.id);
    const r = sub.el.getBoundingClientRect();
    const p = placeSubmenu({ item: btn.getBoundingClientRect(), parent: level.el.getBoundingClientRect(), w: r.width, h: r.height, vw: document.documentElement.clientWidth, vh: innerHeight });
    sub.el.dataset.side = p.side;
    this._put(sub.el, p);
    if (focus) this._focus(sub, 0);
  }

  _activate(level, i, { keyboard = false } = {}) {
    const it = level.items[i];
    if (!it || it.disabled) return;
    if (it.items) return this._openSub(level, i, true);
    this.close({ restore: true });
    try {
      it.run?.({ keyboard });
    } catch (err) {
      console.warn('popcornpals menu:', err);
    }
  }

  _key(e, level) {
    const at = level.buttons.indexOf(document.activeElement);
    const it = level.items[at];
    const key = e.key;
    let handled = true;
    const next = moveIndex(key, at, level.buttons.length);
    if (next !== null) this._focus(level, next);
    else if (key === 'ArrowRight' && it?.items) this._openSub(level, at, true);
    else if (key === 'ArrowLeft' && level.depth > 0) {
      const parent = level.parentBtn;
      this._closeFrom(level.depth);
      parent?.focus();
    } else if ((key === 'Enter' || key === ' ') && at >= 0) this._activate(level, at, { keyboard: true });
    else if (key === 'Escape') {
      if (level.depth > 0) {
        const parent = level.parentBtn;
        this._closeFrom(level.depth);
        parent?.focus();
      } else this.close();
    } else if (key === 'Tab') this.close();
    else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && key !== ' ') {
      const now = Date.now();
      this.typed = now - this.typedAt < 700 ? this.typed + key : key;
      this.typedAt = now;
      const hit = typeahead(level.items.map((x) => x.label), at, this.typed);
      if (hit >= 0) this._focus(level, hit);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

/**
 * Open the menu for elements inside root. resolve(target) returns
 * { items, label, anchor } for a target that has a menu, or null.
 */
export function bindContextMenu(root, menu, resolve) {
  let press = null;
  let quietUntil = 0;

  const openFor = (target, { x, y, keyboard = false } = {}) => {
    const spec = resolve(target);
    if (!spec?.items?.length) return false;
    let px = x;
    let py = y;
    if (keyboard) {
      const r = (spec.anchor || target).getBoundingClientRect();
      px = r.left + Math.min(16, r.width / 2);
      py = r.top + Math.min(r.height, 36);
    }
    menu.open(spec.items, { x: px, y: py, label: spec.label, from: document.activeElement !== document.body ? document.activeElement : target, focusFirst: keyboard });
    return true;
  };
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('.ctx-menu')) return;
    if (Date.now() < quietUntil) {
      e.preventDefault();
      return;
    }
    // A contextmenu from the keyboard has no pointer position.
    const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
    const touching = !!press;
    if (openFor(e.target, { x: e.clientX, y: e.clientY, keyboard })) {
      e.preventDefault();
      cancelPress();
      // A touch browser sends this for a long press: swallow the click that ends it.
      if (touching) quietUntil = Date.now() + 800;
    }
  });

  root.addEventListener('keydown', (e) => {
    if (e.target.closest?.('.ctx-menu')) return;
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    // Focus is inside the menu now, so a contextmenu the browser may still
    // send for this key lands on the menu, which ignores it.
    if (openFor(e.target, { keyboard: true })) e.preventDefault();
  });

  // Long press on touch screens (some browsers send no contextmenu for it).
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    cancelPress();
    const target = e.target;
    const { clientX: x, clientY: y } = e;
    press = {
      x,
      y,
      timer: setTimeout(() => {
        press = null;
        if (openFor(target, { x, y })) {
          quietUntil = Date.now() + 800;
          navigator.vibrate?.(8);
        }
      }, LONG_PRESS_MS),
    };
  });
  root.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_SLOP) cancelPress();
  });
  for (const type of ['pointerup', 'pointercancel']) root.addEventListener(type, cancelPress);
  // The click that ends a long press must not also press what is under the finger.
  root.addEventListener(
    'click',
    (e) => {
      if (Date.now() < quietUntil && !e.target.closest?.('.ctx-menu')) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
