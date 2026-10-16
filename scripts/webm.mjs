// A minimal WebM (Matroska) muxer for a VP8 video track and an optional Opus
// audio track, enough to turn encoded frames into a file browsers can play and
// seek: EBML header, a SeekHead, Info with the duration, Tracks, one Cluster
// per video key frame and Cues.

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  SeekHead: [0x11, 0x4d, 0x9b, 0x74],
  Seek: [0x4d, 0xbb],
  SeekID: [0x53, 0xab],
  SeekPosition: [0x53, 0xac],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  Duration: [0x44, 0x89],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  CodecPrivate: [0x63, 0xa2],
  CodecDelay: [0x56, 0xaa],
  SeekPreRoll: [0x56, 0xbb],
  Audio: [0xe1],
  SamplingFrequency: [0xb5],
  Channels: [0x9f],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
  Cues: [0x1c, 0x53, 0xbb, 0x6b],
  CuePoint: [0xbb],
  CueTime: [0xb3],
  CueTrackPositions: [0xb7],
  CueTrack: [0xf7],
  CueClusterPosition: [0xf1],
};

const concat = (parts) => {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** An element size as an 8 byte EBML variable length integer. */
function size8(n) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = BigInt(n);
  for (let i = 7; i >= 1; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function uintBytes(n, width) {
  let w = width;
  if (!w) {
    w = 1;
    while (n >= 2 ** (8 * w) && w < 8) w++;
  }
  const out = new Uint8Array(w);
  let v = BigInt(n);
  for (let i = w - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const el = (id, body) => concat([Uint8Array.from(id), size8(body.length), body]);
const master = (id, children) => el(id, concat(children));
const uint = (id, n, width) => el(id, uintBytes(n, width));
const str = (id, s) => el(id, new TextEncoder().encode(s));
const float = (id, v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
};

/**
 * frames: [{ timestamp (microseconds), key (boolean), data (Uint8Array) }]
 * audio (optional): { frames, sampleRate, channels, preSkip }, Opus packets
 * Returns the bytes of a WebM file.
 */

/** The OpusHead block Matroska keeps as the audio track's CodecPrivate. */
export function opusHead({ channels, sampleRate, preSkip = 312 }) {
  const b = new Uint8Array(19);
  b.set(new TextEncoder().encode('OpusHead'));
  const v = new DataView(b.buffer);
  v.setUint8(8, 1);
  v.setUint8(9, channels);
  v.setUint16(10, preSkip, true);
  v.setUint32(12, sampleRate, true);
  v.setInt16(16, 0, true);
  v.setUint8(18, 0);
  return b;
}

export function muxWebm({ width, height, frames, durationMs, audio = null }) {
  const header = master(ID.EBML, [uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4), uint(ID.EBMLMaxSizeLength, 8), str(ID.DocType, 'webm'), uint(ID.DocTypeVersion, 2), uint(ID.DocTypeReadVersion, 2)]);
  const info = master(ID.Info, [uint(ID.TimecodeScale, 1000000), float(ID.Duration, durationMs), str(ID.MuxingApp, 'popcornpals test'), str(ID.WritingApp, 'popcornpals test')]);
  const entries = [master(ID.TrackEntry, [uint(ID.TrackNumber, 1), uint(ID.TrackUID, 1), uint(ID.TrackType, 1), str(ID.CodecID, 'V_VP8'), master(ID.Video, [uint(ID.PixelWidth, width), uint(ID.PixelHeight, height)])])];
  if (audio) {
    const preSkip = audio.preSkip ?? 312;
    entries.push(
      master(ID.TrackEntry, [
        uint(ID.TrackNumber, 2),
        uint(ID.TrackUID, 2),
        uint(ID.TrackType, 2),
        str(ID.CodecID, 'A_OPUS'),
        el(ID.CodecPrivate, opusHead({ channels: audio.channels, sampleRate: audio.sampleRate, preSkip })),
        uint(ID.CodecDelay, Math.round((preSkip / 48000) * 1e9)),
        uint(ID.SeekPreRoll, 80000000),
        master(ID.Audio, [float(ID.SamplingFrequency, audio.sampleRate), uint(ID.Channels, audio.channels)]),
      ]),
    );
  }
  const tracks = master(ID.Tracks, entries);

  // Every packet of both tracks in time order (video first on a tie, so clusters open on a key frame).
  const all = [...frames.map((f) => ({ ...f, track: 1 })), ...(audio?.frames || []).map((f) => ({ ...f, track: 2, key: true }))].sort((a, b) => a.timestamp - b.timestamp || a.track - b.track);

  // Clusters: a new one at every video key frame.
  const clusters = [];
  let current = null;
  for (const f of all) {
    const ms = Math.round(f.timestamp / 1000);
    if ((f.track === 1 && f.key) || !current) {
      current = { time: ms, blocks: [] };
      clusters.push(current);
    }
    const rel = ms - current.time;
    const head = new Uint8Array(4);
    head[0] = 0x80 | f.track;
    new DataView(head.buffer).setInt16(1, rel);
    head[3] = f.key ? 0x80 : 0x00;
    current.blocks.push(el(ID.SimpleBlock, concat([head, f.data])));
  }
  const clusterBytes = clusters.map((c) => master(ID.Cluster, [uint(ID.Timecode, c.time), ...c.blocks]));

  // Layout inside the segment: SeekHead, Info, Tracks, Clusters, Cues.
  const seekEntry = (id, pos) => master(ID.Seek, [el(ID.SeekID, Uint8Array.from(id)), uint(ID.SeekPosition, pos, 8)]);
  const seekHeadSize = master(ID.SeekHead, [seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)]).length;
  const infoPos = seekHeadSize;
  const tracksPos = infoPos + info.length;
  let pos = tracksPos + tracks.length;
  const cuePoints = [];
  clusters.forEach((c, i) => {
    cuePoints.push(master(ID.CuePoint, [uint(ID.CueTime, c.time), master(ID.CueTrackPositions, [uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, pos, 8)])]));
    pos += clusterBytes[i].length;
  });
  const cuesPos = pos;
  const cues = master(ID.Cues, cuePoints);
  const seekHead = master(ID.SeekHead, [seekEntry(ID.Info, infoPos), seekEntry(ID.Tracks, tracksPos), seekEntry(ID.Cues, cuesPos)]);
  const segment = master(ID.Segment, [seekHead, info, tracks, ...clusterBytes, cues]);
  return concat([header, segment]);
}
