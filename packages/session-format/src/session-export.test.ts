// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { assembleSession, type ExportManifest } from './session-export';

const python = process.platform === 'win32' ? 'python' : 'python3';

function manifest(rate = 192000, length = rate * 60): ExportManifest {
  return {
    format: 'LoopBeatsSession',
    version: 1,
    sampleRate: rate,
    cycleLengthSamples: length,
    masterGain: 1,
    tracks: [0, 1].map((id) => ({
      id,
      mode: 'Loop',
      gain: 1,
      muted: false,
      lengthSamples: length,
      audioPath: `tracks/${id}.wav`,
    })),
  };
}

test('assembles both maximum recordings into independently validated ZIP/WAVs', async () => {
  const source = manifest();
  const calls = [0, 0];
  const archive = await assembleSession(
    source,
    async (id, offset, frames) => {
      expect(frames).toBeLessThanOrEqual(2048);
      expect(offset).toBe(calls[id]);
      calls[id] += frames;
      return new Float32Array(frames).fill(id === 0 ? 0.25 : -1.5);
    },
    () => {},
    () => {},
  );
  expect(calls).toEqual([11520000, 11520000]);
  expect(archive.size).toBeLessThanOrEqual(96 * 1024 * 1024);
  const directory = await mkdtemp(join(tmpdir(), 'loopbeats-export-'));
  try {
    const path = join(directory, 'session.zip');
    await writeFile(path, Buffer.from(await archive.arrayBuffer()));
    const decoded = JSON.parse(
      execFileSync(
        python,
        [
          '-c',
          `
import json, sys, zipfile, struct
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 m=json.loads(z.read('session.json'))
 assert z.namelist()==['session.json','tracks/0.wav','tracks/1.wav']
 result=[]
 for i in range(2):
  w=z.read('tracks/'+str(i)+'.wav')
  assert w[:4]==b'RIFF' and w[8:16]==b'WAVEfmt '
  assert struct.unpack_from('<HHI',w,20)==(3,1,192000)
  assert struct.unpack_from('<I',w,4)[0]==len(w)-8
  assert w[36:40]==b'fact' and w[48:52]==b'data'
  assert struct.unpack_from('<II',w,40)==(4,11520000)
  assert struct.unpack_from('<I',w,52)[0]==46080000
  expected=struct.pack('<f',0.25 if i==0 else -1.5)
  assert w[56:]==expected*11520000
  result.append(len(w))
 print(json.dumps({'manifest':m,'wavBytes':result}))
`,
          path,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(decoded.manifest).toEqual(source);
    expect(decoded.wavBytes).toEqual([46080056, 46080056]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test.each([8000, 192000])('accepts source rate boundary %i', async (rate) => {
  const archive = await assembleSession(
    manifest(rate, 1),
    async () => new Float32Array([0.25]),
    () => {},
    () => {},
  );
  expect(archive.type).toBe('application/zip');
});

test('exports version 2 FX configuration in the versioned ZIP/WAV format', async () => {
  const source: ExportManifest = {
    format: 'LoopBeatsSession',
    version: 2,
    sampleRate: 48000,
    cycleLengthSamples: 2,
    masterGain: 0.75,
    inputFx: { type: 'LowPass', cutoffHz: 1200, bypassed: false },
    masterFx: { type: 'None' },
    tracks: [
      {
        id: 0,
        mode: 'Loop',
        gain: 0.5,
        muted: false,
        lengthSamples: 2,
        audioPath: 'tracks/0.wav',
        fx: { type: 'None' },
      },
      {
        id: 1,
        mode: 'OneShot',
        gain: 1,
        muted: true,
        lengthSamples: 0,
        audioPath: null,
        fx: { type: 'LowPass', cutoffHz: 800, bypassed: true },
      },
    ],
  };
  const archive = await assembleSession(
    source,
    async () => new Float32Array([0.25, -0.5]),
    () => {},
    () => {},
  );
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const metadataLength = view.getUint32(18, true);
  const metadataStart = 30 + 'session.json'.length;
  const exported = JSON.parse(
    new TextDecoder().decode(
      bytes.subarray(metadataStart, metadataStart + metadataLength),
    ),
  );
  expect(exported).toEqual(source);

  const waveHeader = metadataStart + metadataLength;
  expect(view.getUint32(waveHeader, true)).toBe(0x04034b50);
  expect(
    new TextDecoder().decode(
      bytes.subarray(waveHeader + 30, waveHeader + 30 + 'tracks/0.wav'.length),
    ),
  ).toBe('tracks/0.wav');
  const wave = waveHeader + 30 + 'tracks/0.wav'.length;
  expect(new TextDecoder().decode(bytes.subarray(wave, wave + 4))).toBe('RIFF');
  expect(view.getFloat32(wave + 56, true)).toBe(0.25);
  expect(view.getFloat32(wave + 60, true)).toBe(-0.5);
});

test('accepts 64 KiB JSON and rejects one byte more before transfer', async () => {
  // Extra metadata models a malformed processing-side reply at the serializer seam.
  const source = { ...manifest(8000, 0), padding: '' };
  source.tracks.forEach((track) => {
    track.audioPath = null;
  });
  source.padding = 'x'.repeat(
    65536 - new TextEncoder().encode(JSON.stringify(source)).length,
  );
  const read = vi.fn(async () => new Float32Array(0));
  const archive = await assembleSession(
    source,
    read,
    () => {},
    () => {},
  );
  expect(archive.size).toBeLessThanOrEqual(96 * 1024 * 1024);
  source.padding += 'x';
  await expect(
    assembleSession(
      source,
      read,
      () => {},
      () => {},
    ),
  ).rejects.toThrow('Session exceeds export capacity');
  expect(read).not.toHaveBeenCalled();
});

test.each([
  ['below minimum rate', () => manifest(7999, 1)],
  ['above maximum rate', () => manifest(192001, 1)],
  ['fractional rate', () => manifest(48000.5, 1)],
  ['negative length', () => manifest(48000, -1)],
  ['fractional length', () => manifest(48000, 1.5)],
  ['non-finite length', () => manifest(48000, Infinity)],
  ['over sixty seconds', () => manifest(192000, 11520001)],
  ['oversized archive and memory estimate', () => manifest(192000, 100000000)],
  [
    'oversized JSON',
    () => {
      const value = manifest(48000, 1);
      value.tracks[0].audioPath = 'x'.repeat(65536);
      return value;
    },
  ],
] as const)(
  'rejects %s before transfer or WAV/Blob allocation',
  async (_, create) => {
    const read = vi.fn(async () => new Float32Array(1));
    const check = vi.fn();
    const blob = vi.fn();
    vi.stubGlobal('Blob', blob);
    try {
      await expect(
        assembleSession(create(), read, check, () => {}),
      ).rejects.toThrow('Session exceeds export capacity');
      expect(read).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(blob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
