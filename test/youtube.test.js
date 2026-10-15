import { describe, expect, it } from 'vitest';
import { parseStart, parseYouTube, thumbnailUrl } from '../src/youtube.js';

describe('parseYouTube', () => {
  it('reads every common link shape', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
      'http://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x',
      'https://youtu.be/dQw4w9WgXcQ',
      'youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      '  dQw4w9WgXcQ  ',
    ]) {
      expect(parseYouTube(link)?.id, link).toBe('dQw4w9WgXcQ');
    }
  });

  it('reads start times', () => {
    expect(parseYouTube('https://youtu.be/dQw4w9WgXcQ?t=90').start).toBe(90);
    expect(parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s').start).toBe(90);
    expect(parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=1h2m3s').start).toBe(3723);
    expect(parseStart('nonsense')).toBe(0);
    expect(parseStart('')).toBe(0);
  });

  it('refuses other sites, other schemes and broken ids', () => {
    expect(parseYouTube('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTube('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseYouTube('javascript:alert(1)')).toBeNull();
    expect(parseYouTube('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseYouTube('https://www.youtube.com/channel/abc')).toBeNull();
    expect(parseYouTube('')).toBeNull();
    expect(thumbnailUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  });
});
