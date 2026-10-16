import { describe, expect, it } from 'vitest';
import { cleanCues, cueText, parseSubtitles, parseTime } from '../src/subtitles.js';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Hello <i>there</i>',
  '',
  '2',
  '00:00:03,000 --> 00:00:05,000',
  'Second line',
  'continues',
  '',
  '3',
  '00:00:09,000 --> 00:00:08,000',
  'broken',
  '',
].join('\n');

const VTT = ['WEBVTT', '', 'NOTE a comment', '', 'intro', '00:01.000 --> 00:02.250 align:start', '<v Ana>Popcorn &amp; friends', '', '01:00:00.000 --> 01:00:01.000', 'An hour in', ''].join('\n');

describe('subtitles', () => {
  it('reads times in both formats', () => {
    expect(parseTime('00:00:01,000')).toBe(1);
    expect(parseTime('01:02.5')).toBe(62.5);
    expect(parseTime('1:00:00.000')).toBe(3600);
    expect(parseTime('soon')).toBeNaN();
  });

  it('reads SRT, drops tags and broken cues', () => {
    const cues = parseSubtitles(`\uFEFF${SRT.replace(/\n/g, '\r\n')}`);
    expect(cues).toEqual([
      { start: 1, end: 3.5, text: 'Hello there' },
      { start: 3, end: 5, text: 'Second line\ncontinues' },
    ]);
  });

  it('reads WebVTT with identifiers, settings and notes', () => {
    expect(parseSubtitles(VTT)).toEqual([
      { start: 1, end: 2.25, text: 'Popcorn & friends' },
      { start: 3600, end: 3601, text: 'An hour in' },
    ]);
  });

  it('finds the text on screen at any moment, overlaps included', () => {
    const cues = parseSubtitles(SRT);
    expect(cueText(cues, 0.5)).toBe('');
    expect(cueText(cues, 2)).toBe('Hello there');
    expect(cueText(cues, 3.2)).toBe('Hello there\nSecond line\ncontinues');
    expect(cueText(cues, 6)).toBe('');
    expect(cueText([], 1)).toBe('');
  });

  it('cleans cues that came from a peer', () => {
    expect(cleanCues([{ start: 1, end: 2, text: '<b>hi</b>' }, { start: 3, end: 2, text: 'x' }, { start: 'a' }, null])).toEqual([{ start: 1, end: 2, text: 'hi' }]);
    expect(cleanCues('nope')).toEqual([]);
  });
});
