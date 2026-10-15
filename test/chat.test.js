import { describe, expect, it } from 'vitest';
import { MAX_MESSAGES, MAX_TEXT, RateLimit, addMessage, cleanMessage, cleanText, toggleReaction } from '../src/chat.js';
import { cleanName, colorFor, initials } from '../src/people.js';

describe('chat', () => {
  it('cleans text and refuses empty or malformed messages', () => {
    expect(cleanText('  hi\u0007 there \n\n\n\nyou ')).toBe('hi there \n\nyou');
    expect(cleanText('x'.repeat(900))).toHaveLength(MAX_TEXT);
    expect(cleanMessage({ id: 'abcd1234', text: '   ' }, 'a')).toBeNull();
    expect(cleanMessage({ id: '<b>', text: 'hi' }, 'a')).toBeNull();
    expect(cleanMessage({ id: 'abcd1234', text: 'hi', ts: 5 }, 'a')).toEqual({ id: 'abcd1234', from: 'a', text: 'hi', ts: 5, reactions: {} });
  });

  it('toggles reactions per person and drops empty ones', () => {
    const m = cleanMessage({ id: 'abcd1234', text: 'hi' }, 'a');
    expect(toggleReaction(m, 'popcorn', 'bia')).toBe(true);
    expect(toggleReaction(m, 'popcorn', 'caio')).toBe(true);
    expect(m.reactions.popcorn).toEqual(['bia', 'caio']);
    expect(toggleReaction(m, 'popcorn', 'bia', true)).toBe(false);
    expect(toggleReaction(m, 'popcorn', 'bia')).toBe(true);
    expect(toggleReaction(m, 'popcorn', 'caio', false)).toBe(true);
    expect(m.reactions).toEqual({});
    expect(toggleReaction(m, 'fire', 'bia')).toBe(false);
  });

  it('keeps messages in time order without duplicates, newest last', () => {
    const list = [];
    addMessage(list, { id: 'b', ts: 2 });
    addMessage(list, { id: 'a', ts: 1 });
    expect(addMessage(list, { id: 'a', ts: 1 })).toBe(false);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
    for (let i = 0; i < MAX_MESSAGES + 5; i++) addMessage(list, { id: `m${i}`, ts: 10 + i });
    expect(list).toHaveLength(MAX_MESSAGES);
    expect(list.at(-1).id).toBe(`m${MAX_MESSAGES + 4}`);
  });

  it('limits bursts per sender', () => {
    let t = 0;
    const r = new RateLimit({ max: 2, windowMs: 1000, now: () => t });
    expect([r.allow('a'), r.allow('a'), r.allow('a'), r.allow('b')]).toEqual([true, true, false, true]);
    t = 1500;
    expect(r.allow('a')).toBe(true);
  });
});

describe('people', () => {
  it('cleans names, picks stable colors and initials', () => {
    expect(cleanName('  Ana   Maria  ')).toBe('Ana Maria');
    expect(cleanName('')).toBe('Guest');
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
    expect(colorFor('abc')).toBe(colorFor('abc'));
    expect(initials('Ana Maria')).toBe('AM');
    expect(initials('Bia')).toBe('BI');
  });
});
