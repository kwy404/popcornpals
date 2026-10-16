// How much the person streaming a file can send. They upload one copy of the
// video to each guest, so the upload speed is shared by everyone watching.
// streamQuality() turns the guest count and the measured upload into a
// bitrate cap and a resolution scale for each copy, and a label for the UI.

export const MIN_BITRATE = 250_000;
export const MAX_BITRATE = 6_000_000;
/** What the app assumes before the connection has measured anything. */
export const DEFAULT_UPLOAD = 4_000_000;

const LEVELS = [
  { min: 2_500_000, height: 1080, label: 'high' },
  { min: 1_200_000, height: 720, label: 'good' },
  { min: 600_000, height: 480, label: 'fair' },
  { min: 0, height: 360, label: 'low' },
];

/**
 * guests: how many people receive a copy
 * uploadBps: measured upload in bits per second (null when unknown)
 * height: the source video height in pixels (null when unknown)
 * Returns { maxBitrate, scaleResolutionDownBy, height, label, perGuest }.
 */
export function streamQuality({ guests, uploadBps, height }) {
  const n = Math.max(1, Math.floor(guests) || 1);
  const upload = Number.isFinite(uploadBps) && uploadBps > 0 ? uploadBps : DEFAULT_UPLOAD;
  // Keep 15 percent for voice, chat and the audio of the film itself.
  const perGuest = (upload * 0.85) / n;
  const maxBitrate = Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, perGuest)));
  const level = LEVELS.find((l) => perGuest >= l.min);
  const src = Number.isFinite(height) && height > 0 ? height : null;
  const target = src ? Math.min(src, level.height) : level.height;
  const scale = src ? Math.max(1, Math.round((src / target) * 100) / 100) : 1;
  return { maxBitrate, scaleResolutionDownBy: scale, height: target, label: level.label, perGuest: Math.round(perGuest) };
}

/** A short, honest description: "720p, 2.1 Mb/s per guest". */
export function qualityText({ height, maxBitrate }) {
  return `${height}p, ${(maxBitrate / 1e6).toFixed(1)} Mb/s`;
}
