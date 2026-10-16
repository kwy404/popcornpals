import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STRINGS, pickLang, translate } from '../docs/app/js/i18n.js';

const html = readFileSync('docs/app/index.html', 'utf8');
const scripts = readdirSync('docs/app/js').map((f) => readFileSync(`docs/app/js/${f}`, 'utf8'));
const used = new Set();
for (const text of [html, ...scripts]) for (const m of text.matchAll(/\bt\('([a-zA-Z][\w.-]*)'/g)) used.add(m[1]);

describe('app strings', () => {
  it('has every key in English and Portuguese', () => {
    expect(Object.keys(STRINGS.pt).sort()).toEqual(Object.keys(STRINGS.en).sort());
    for (const lang of ['en', 'pt']) for (const [k, v] of Object.entries(STRINGS[lang])) expect(v.trim(), `${lang} ${k}`).not.toBe('');
  });

  it('defines every key the page and the scripts use', () => {
    const missing = [...used].filter((k) => !k.endsWith('.') && !(k in STRINGS.en));
    expect(missing).toEqual([]);
  });

  it('keeps the same placeholders in both languages', () => {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(STRINGS.en)) expect(vars(STRINGS.pt[k]), k).toEqual(vars(STRINGS.en[k]));
  });

  it('fills placeholders and picks the language', () => {
    expect(translate('en', 'room.watching', { n: 3, max: 5 })).toBe('3 of 5 watching');
    expect(translate('pt', 'room.watching', { n: 3, max: 5 })).toBe('3 de 5 assistindo');
    expect(translate('pt', 'nope.key')).toBe('nope.key');
    expect(pickLang(null, ['pt-BR', 'en'])).toBe('pt');
    expect(pickLang(null, ['de-DE'])).toBe('en');
    expect(pickLang('en', ['pt-BR'])).toBe('en');
  });

  it('never shows an invite link: only the six words and the QR code', () => {
    const start = html.indexOf(`v-if="S.invite.stage === 'waiting'"`);
    const invite = html.slice(start, html.indexOf(`v-if="S.invite.stage === 'connecting'"`, start));
    expect(invite).toContain('invite-words');
    expect(invite).toContain('ticket-qr');
    expect(invite).not.toMatch(/<input|href=|copy/i);
  });

  it('loads Monsoon 0.2.0 and Voodoo.js 1.0.0 and uses only relative paths', () => {
    expect(html).toContain('https://cdn.jsdelivr.net/npm/monsooncss@0.2.0/dist/monsoon.min.css');
    expect(html).toContain('https://cdn.jsdelivr.net/npm/voodoojs@1.0.0/dist/voodoo.full.min.js');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) expect(m[1].startsWith('/'), m[1]).toBe(false);
  });

  it('caches every app script in the service worker', () => {
    const sw = readFileSync('docs/app/sw.js', 'utf8');
    for (const f of readdirSync('docs/app/js')) expect(sw, f).toContain(`'js/${f}'`);
    for (const f of readdirSync('docs/app/core')) expect(sw, f).toContain(`'core/${f}'`);
  });
});
