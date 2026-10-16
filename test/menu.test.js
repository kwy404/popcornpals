import { describe, expect, it } from 'vitest';
import { moveIndex, placeMenu, placeSubmenu, typeahead } from '../src/menu.js';

describe('context menu placement', () => {
  const vp = { vw: 1000, vh: 700 };

  it('opens down and to the right of the point when it fits', () => {
    expect(placeMenu({ x: 100, y: 120, w: 240, h: 300, ...vp })).toEqual({ left: 100, top: 120, maxHeight: null, flipX: false, flipY: false });
  });

  it('flips left and up near the right and bottom edges', () => {
    const p = placeMenu({ x: 900, y: 600, w: 240, h: 300, ...vp });
    expect(p).toMatchObject({ left: 660, top: 300, flipX: true, flipY: true });
  });

  it('stays inside the margins when neither side has room', () => {
    const p = placeMenu({ x: 150, y: 350, w: 240, h: 300, vw: 300, vh: 500 });
    expect(p.left).toBe(8);
    expect(p.left + 240).toBeLessThanOrEqual(300 - 8 + 240);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + 300).toBeLessThanOrEqual(500 - 8);
  });

  it('scrolls a menu taller than the viewport', () => {
    const p = placeMenu({ x: 10, y: 10, w: 200, h: 900, vw: 375, vh: 600 });
    expect(p.maxHeight).toBe(584);
    expect(p.top).toBe(8);
  });

  it('puts a submenu to the right of its menu, or to the left at the edge', () => {
    const item = { left: 100, top: 200, right: 340, bottom: 236 };
    const parent = { left: 100, top: 150, right: 340, bottom: 450 };
    expect(placeSubmenu({ item, parent, w: 200, h: 180, ...vp })).toEqual({ left: 336, top: 194, maxHeight: null, side: 'right' });
    const nearEdge = { left: 760, top: 150, right: 1000, bottom: 450 };
    const s = placeSubmenu({ item: { ...item, left: 760, right: 1000 }, parent: nearEdge, w: 200, h: 180, ...vp });
    expect(s.side).toBe('left');
    expect(s.left).toBe(564);
  });

  it('keeps a submenu low in the viewport above the bottom edge', () => {
    const s = placeSubmenu({ item: { left: 0, top: 650, right: 200, bottom: 686 }, parent: { left: 0, top: 400, right: 200, bottom: 690 }, w: 180, h: 200, ...vp });
    expect(s.top).toBe(700 - 8 - 200);
  });
});

describe('context menu keys', () => {
  it('moves with the arrows, wrapping, and jumps with Home and End', () => {
    expect(moveIndex('ArrowDown', -1, 4)).toBe(0);
    expect(moveIndex('ArrowDown', 3, 4)).toBe(0);
    expect(moveIndex('ArrowUp', 0, 4)).toBe(3);
    expect(moveIndex('ArrowUp', -1, 4)).toBe(3);
    expect(moveIndex('Home', 2, 4)).toBe(0);
    expect(moveIndex('End', 0, 4)).toBe(3);
    expect(moveIndex('x', 0, 4)).toBeNull();
    expect(moveIndex('ArrowDown', 0, 0)).toBeNull();
  });

  it('finds items by their first letters, cycling on a repeated letter', () => {
    const labels = ['Play', 'Sync everyone to me', 'Speed', 'Picture in picture', 'Fullscreen'];
    expect(typeahead(labels, 0, 's')).toBe(1);
    expect(typeahead(labels, 1, 's')).toBe(2);
    expect(typeahead(labels, 2, 's')).toBe(1);
    expect(typeahead(labels, -1, 'pi')).toBe(3);
    expect(typeahead(['Câmera', 'Copiar'], -1, 'ca')).toBe(0);
    expect(typeahead(labels, 0, 'z')).toBe(-1);
  });
});
