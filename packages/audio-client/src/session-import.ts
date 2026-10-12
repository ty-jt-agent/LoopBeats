import type { ExportManifest } from './session-export';
import { fitsImportMemory, SESSION_AUDIO_BYTES } from './session-limits';
import { defaultFx, parseUniqueJson, validFx } from './session-fx';

const LIMIT = 96 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
function invalid(): never {
  throw new Error(
    'Invalid or unsupported session ZIP. The current session is unchanged.',
  );
}
function integer(value: unknown, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}
function gain(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
function keys(value: object, expected: string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((k) => !Object.hasOwn(value, k))
  )
    invalid();
}
/** Validate the entire uncompressed archive outside the audio thread; retain WAV views. */
export async function parseSession(
  buffer: ArrayBuffer,
  rate: number,
  check: () => void = () => {},
  allowDifferentRate = false,
) {
  check();
  if (buffer.byteLength < 22 || buffer.byteLength > LIMIT) invalid();
  const bytes = new Uint8Array(buffer),
    view = new DataView(buffer);
  const end = bytes.length - 22;
  if (
    view.getUint32(end, true) !== 0x06054b50 ||
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 20, true)
  )
    invalid();
  const count = view.getUint16(end + 10, true),
    directory = view.getUint32(end + 16, true);
  if (
    count < 1 ||
    count > 3 ||
    view.getUint16(end + 8, true) !== count ||
    directory + view.getUint32(end + 12, true) !== end
  )
    invalid();
  const files = new Map<string, Uint8Array>();
  let cursor = directory,
    local = 0;
  for (let entry = 0; entry < count; entry++) {
    check();
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      invalid();
    const size = view.getUint32(cursor + 24, true),
      checksum = view.getUint32(cursor + 16, true);
    const nameLength = view.getUint16(cursor + 28, true);
    if (
      view.getUint16(cursor + 8, true) !== 0x800 ||
      view.getUint16(cursor + 10, true) !== 0 ||
      view.getUint16(cursor + 6, true) !== 20 ||
      view.getUint32(cursor + 20, true) !== size ||
      view.getUint16(cursor + 30, true) ||
      view.getUint16(cursor + 32, true) ||
      view.getUint16(cursor + 34, true) ||
      view.getUint32(cursor + 42, true) !== local ||
      cursor + 46 + nameLength > end ||
      local + 30 > directory
    )
      invalid();
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !['session.json', 'tracks/0.wav', 'tracks/1.wav'].includes(name) ||
      files.has(name)
    )
      invalid();
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 4, true) !== 20 ||
      view.getUint16(local + 6, true) !== 0x800 ||
      view.getUint16(local + 8, true) !== 0 ||
      view.getUint32(local + 14, true) !== checksum ||
      view.getUint32(local + 18, true) !== size ||
      view.getUint32(local + 22, true) !== size ||
      view.getUint16(local + 26, true) !== nameLength ||
      view.getUint16(local + 28, true) ||
      local + 30 + nameLength + size > directory ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !==
        name ||
      view.getUint32(local + 10, true) !== view.getUint32(cursor + 12, true)
    )
      invalid();
    if (name === 'session.json' && size > 65536) invalid();
    const payload = bytes.subarray(
      local + 30 + nameLength,
      local + 30 + nameLength + size,
    );
    let crc = 0xffffffff;
    for (let offset = 0; offset < payload.length; offset += 1048576) {
      check();
      for (const byte of payload.subarray(offset, offset + 1048576)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if ((crc ^ 0xffffffff) >>> 0 !== checksum) invalid();
    files.set(name, payload);
    cursor += 46 + nameLength;
    local += 30 + nameLength + size;
  }
  if (cursor !== end || local !== directory || !files.has('session.json'))
    invalid();
  const manifest = parseUniqueJson(
    decoder.decode(files.get('session.json')),
  ) as ExportManifest;
  if (!manifest || typeof manifest !== 'object') invalid();
  keys(manifest, [
    'format',
    'version',
    'sampleRate',
    'cycleLengthSamples',
    'masterGain',
    'tracks',
    ...(manifest.version === 2 ? ['inputFx', 'masterFx'] : []),
  ]);
  if (
    manifest.format !== 'LoopBeatsSession' ||
    ![1, 2].includes(manifest.version) ||
    !integer(manifest.sampleRate, 192000) ||
    manifest.sampleRate < 8000 ||
    !integer(manifest.cycleLengthSamples, manifest.sampleRate * 60) ||
    !gain(manifest.masterGain) ||
    !Array.isArray(manifest.tracks) ||
    manifest.tracks.length !== 2
  )
    invalid();
  if (
    manifest.version === 2 &&
    (!validFx(manifest.inputFx, manifest.sampleRate) ||
      !validFx(manifest.masterFx, manifest.sampleRate))
  )
    invalid();
  let total = 0;
  const waves: (DataView | null)[] = [];
  for (const [id, track] of manifest.tracks.entries()) {
    if (!track || typeof track !== 'object') invalid();
    keys(track, [
      'id',
      'mode',
      'gain',
      'muted',
      'lengthSamples',
      'audioPath',
      ...(manifest.version === 2 ? ['fx'] : []),
    ]);
    if (manifest.version === 2 && !validFx(track.fx, manifest.sampleRate))
      invalid();
    if (
      track.id !== id ||
      !['Loop', 'OneShot'].includes(track.mode) ||
      !gain(track.gain) ||
      typeof track.muted !== 'boolean' ||
      !integer(track.lengthSamples, manifest.sampleRate * 60) ||
      track.audioPath !== (track.lengthSamples ? `tracks/${id}.wav` : null) ||
      (track.lengthSamples > 0 &&
        track.mode === 'Loop' &&
        track.lengthSamples !== manifest.cycleLengthSamples)
    )
      invalid();
    total += track.lengthSamples * 4;
    if (!track.audioPath) {
      waves.push(null);
      continue;
    }
    const wave = files.get(track.audioPath);
    if (!wave || wave.length !== 56 + track.lengthSamples * 4) invalid();
    const w = new DataView(wave.buffer, wave.byteOffset, wave.byteLength);
    if (
      decoder.decode(wave.subarray(0, 4)) !== 'RIFF' ||
      decoder.decode(wave.subarray(8, 16)) !== 'WAVEfmt ' ||
      w.getUint32(4, true) !== wave.length - 8 ||
      w.getUint32(16, true) !== 16 ||
      w.getUint16(20, true) !== 3 ||
      w.getUint16(22, true) !== 1 ||
      w.getUint32(24, true) !== manifest.sampleRate ||
      w.getUint32(28, true) !== manifest.sampleRate * 4 ||
      w.getUint16(32, true) !== 4 ||
      w.getUint16(34, true) !== 32 ||
      decoder.decode(wave.subarray(36, 40)) !== 'fact' ||
      w.getUint32(40, true) !== 4 ||
      w.getUint32(44, true) !== track.lengthSamples ||
      decoder.decode(wave.subarray(48, 52)) !== 'data' ||
      w.getUint32(52, true) !== track.lengthSamples * 4
    )
      invalid();
    for (let start = 0; start < track.lengthSamples; start += 262144) {
      check();
      for (
        let i = start;
        i < Math.min(start + 262144, track.lengthSamples);
        i++
      )
        if (!Number.isFinite(w.getFloat32(56 + i * 4, true))) invalid();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    waves.push(w);
  }
  if (
    total > SESSION_AUDIO_BYTES ||
    files.size !== 1 + waves.filter(Boolean).length
  )
    invalid();
  // Reserved bank (4.25 bytes/frame), file and one bounded copy remain below 384 MiB.
  if (!fitsImportMemory(buffer.byteLength, rate, 8192)) invalid();
  if (manifest.sampleRate !== rate && !allowDifferentRate)
    throw new Error(
      `Session sample rate is ${manifest.sampleRate} Hz; current audio is ${rate} Hz. Sample-rate conversion is not available yet. The current session is unchanged.`,
    );
  check();
  // Migration is explicit and happens only after complete source validation.
  if (manifest.version === 1) {
    manifest.inputFx = defaultFx(manifest.sampleRate);
    manifest.masterFx = defaultFx(manifest.sampleRate);
    for (const track of manifest.tracks)
      track.fx = defaultFx(manifest.sampleRate);
  }
  return {
    byteLength: buffer.byteLength,
    manifest,
    recording(id: number): (position: number) => number {
      const wave = waves[id];
      if (!wave) invalid();
      return (position) => wave.getFloat32(56 + position * 4, true);
    },
    read(id: number, offset: number, frames: number) {
      const wave = waves[id];
      if (
        !wave ||
        !integer(offset, manifest.tracks[id].lengthSamples) ||
        !integer(frames, 2048) ||
        frames < 1 ||
        offset + frames > manifest.tracks[id].lengthSamples
      )
        invalid();
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++)
        samples[i] = wave.getFloat32(56 + (offset + i) * 4, true);
      return samples;
    },
  };
}
