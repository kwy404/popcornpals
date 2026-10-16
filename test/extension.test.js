import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundle, outputs } from '../scripts/build-extension.mjs';

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const meta = JSON.parse(readFileSync('docs/extension/latest.json', 'utf8'));

describe('the extension download', () => {
  it('is the zip of the current extension sources', () => {
    const { out } = outputs();
    const zip = readFileSync(`docs/extension/${meta.file}`);
    expect(zip.equals(out[`docs/extension/${meta.file}`])).toBe(true);
    expect(readFileSync('extension/lib/sync.js', 'utf8')).toBe(bundle());
  });

  it('publishes its version, size and checksum', () => {
    const zip = readFileSync(`docs/extension/${meta.file}`);
    expect(meta.version).toBe(manifest.version);
    expect(meta.file).toBe(`popcornpals-extension-${manifest.version}.zip`);
    expect(meta.bytes).toBe(zip.length);
    expect(meta.sha256).toBe(createHash('sha256').update(zip).digest('hex'));
  });

  it('asks for as little as it can', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'scripting']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(['https://*/*']);
    expect(manifest.content_scripts).toEqual([{ matches: ['https://kwy404.github.io/popcornpals/app/*'], js: ['bridge.js'], run_at: 'document_start' }]);
  });

  it('never captures, records or downloads media', () => {
    for (const f of ['background.js', 'bridge.js', 'player.js', 'popup.js']) {
      const src = readFileSync(`extension/${f}`, 'utf8');
      expect(src, f).not.toMatch(/captureStream|MediaRecorder|getDisplayMedia|tabCapture|downloads\./);
    }
  });
});
