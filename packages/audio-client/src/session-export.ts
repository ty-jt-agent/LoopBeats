import type { FxConfig, PlaybackMode } from '@loopbeats/domain';
import type { CheckpointInfo } from './session-recovery';

export interface ExportManifest {
  format: 'LoopBeatsSession';
  version: 1 | 2;
  inputFx?: FxConfig;
  masterFx?: FxConfig;
  sampleRate: number;
  cycleLengthSamples: number;
  masterGain: number;
  tracks: {
    id: number;
    mode: PlaybackMode;
    gain: number;
    muted: boolean;
    lengthSamples: number;
    audioPath: string | null;
    fx?: FxConfig;
  }[];
}
export interface ExportReply {
  type: 'export-reply';
  requestId: number;
  error?: string;
  manifest?: ExportManifest;
  samples?: Float32Array;
  captureKinds?: CheckpointInfo['captureKinds'];
  checkpointStartedAt?: number;
}
const ARCHIVE_LIMIT = 96 * 1024 * 1024;
const CHUNK = 2048;
const encoder = new TextEncoder();
function text(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++)
    view.setUint8(offset + i, value.charCodeAt(i));
}
function crc(bytes: Uint8Array, initial = 0xffffffff): number {
  let value = initial;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
}
function wav(length: number, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(56 + length * 4);
  const view = new DataView(bytes.buffer);
  text(view, 0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(view, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  text(view, 36, 'fact');
  view.setUint32(40, 4, true);
  view.setUint32(44, length, true);
  text(view, 48, 'data');
  view.setUint32(52, length * 4, true);
  return bytes;
}
function zip(
  entries: { name: string; bytes: Uint8Array<ArrayBuffer>; checksum: number }[],
): Blob {
  const parts: BlobPart[] = [],
    directory: BlobPart[] = [];
  let offset = 0,
    directorySize = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const header = new Uint8Array(30 + name.length),
      central = new Uint8Array(46 + name.length);
    const h = new DataView(header.buffer),
      c = new DataView(central.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint32(14, entry.checksum, true);
    h.setUint32(18, entry.bytes.length, true);
    h.setUint32(22, entry.bytes.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint32(16, entry.checksum, true);
    c.setUint32(20, entry.bytes.length, true);
    c.setUint32(24, entry.bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(header, entry.bytes);
    directory.push(central);
    offset += header.length + entry.bytes.length;
    directorySize += central.length;
  }
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  if (offset + directorySize + end.length > ARCHIVE_LIMIT)
    throw new Error('Session archive exceeds 96 MiB.');
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}

/** Main-thread assembly; the processing side only supplies bounded completed samples. */
export async function assembleSession(
  manifest: ExportManifest,
  read: (
    trackId: number,
    offset: number,
    frames: number,
  ) => Promise<Float32Array>,
  check: () => void,
  progress: (fraction: number) => void,
): Promise<Blob> {
  const metadata = encoder.encode(JSON.stringify(manifest));
  const total = manifest.tracks.reduce(
    (sum, track) => sum + track.lengthSamples,
    0,
  );
  if (
    !Number.isInteger(manifest.sampleRate) ||
    manifest.sampleRate < 8000 ||
    manifest.sampleRate > 192000 ||
    manifest.tracks.length !== 2 ||
    metadata.length > 65536 ||
    manifest.tracks.some(
      (t) =>
        !Number.isInteger(t.lengthSamples) ||
        t.lengthSamples < 0 ||
        t.lengthSamples > manifest.sampleRate * 60,
    ) ||
    total * 4 + metadata.length + 4096 > ARCHIVE_LIMIT
  )
    throw new Error('Session exceeds export capacity.');
  // Two WAV buffers plus their Blob copy and transfer/serialization overhead fit in 384 MiB.
  const entries = [
    {
      name: 'session.json',
      bytes: metadata,
      checksum: (crc(metadata) ^ 0xffffffff) >>> 0,
    },
  ];
  let copied = 0;
  for (const track of manifest.tracks) {
    if (!track.audioPath) continue;
    check();
    const bytes = wav(track.lengthSamples, manifest.sampleRate),
      view = new DataView(bytes.buffer);
    let checksum = crc(bytes.subarray(0, 56));
    for (let offset = 0; offset < track.lengthSamples; offset += CHUNK) {
      check();
      const frames = Math.min(CHUNK, track.lengthSamples - offset);
      const samples = await read(track.id, offset, frames);
      if (samples.length !== frames)
        throw new Error('Incomplete recording transfer.');
      for (let i = 0; i < frames; i++) {
        if (!Number.isFinite(samples[i]))
          throw new Error('Recording contains non-finite samples.');
        view.setFloat32(56 + (offset + i) * 4, samples[i], true);
      }
      checksum = crc(
        bytes.subarray(56 + offset * 4, 56 + (offset + frames) * 4),
        checksum,
      );
      copied += frames;
      progress(total ? copied / total : 1);
    }
    entries.push({
      name: track.audioPath,
      bytes,
      checksum: (checksum ^ 0xffffffff) >>> 0,
    });
  }
  check();
  progress(1);
  return zip(entries);
}
