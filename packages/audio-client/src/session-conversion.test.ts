// @vitest-environment node
import { expect, test } from 'vitest';
import { assembleSession, type ExportManifest } from './session-export';
import { parseSession } from './session-import';
import { convertSession } from './session-conversion';

async function fixture(
  rate: number,
  length: number,
  sample: (position: number) => number,
  oneShotLength = length,
  bothLoops = false,
) {
  const manifest: ExportManifest = {
    format: 'LoopBeatsSession',
    version: 1,
    sampleRate: rate,
    cycleLengthSamples: length,
    masterGain: 0.5,
    tracks: [0, 1].map((id) => ({
      id,
      mode: id && !bothLoops ? 'OneShot' : 'Loop',
      gain: 0.75,
      muted: Boolean(id),
      lengthSamples: id ? oneShotLength : length,
      audioPath: `tracks/${id}.wav`,
    })),
  };
  const zip = await assembleSession(
    manifest,
    async (_, offset, frames) =>
      Float32Array.from({ length: frames }, (__, i) => sample(offset + i)),
    () => {},
    () => {},
  );
  return parseSession(await zip.arrayBuffer(), rate);
}

test('conversion preserves DC and configuration with independent length rounding', async () => {
  const source = await fixture(48000, 48, () => 0.25, 24);
  const converted = convertSession(source, 44100, () => {});
  expect(converted.manifest.cycleLengthSamples).toBe(44);
  expect(converted.manifest.tracks.map((t) => t.lengthSamples)).toEqual([
    44, 22,
  ]);
  expect(converted.manifest.masterGain).toBe(0.5);
  for (const value of await converted.read(0, 0, 44))
    expect(value).toBeCloseTo(0.25, 6);
});

test('conversion reports scoped cutoff caps and preserves supported Hz without mutating source', async () => {
  const source = await fixture(48000, 48, () => 0.25);
  source.manifest.version = 2;
  source.manifest.inputFx = {
    type: 'LowPass',
    cutoffHz: 15000,
    bypassed: false,
  };
  source.manifest.masterFx = { type: 'None' };
  source.manifest.tracks[0].fx = {
    type: 'LowPass',
    cutoffHz: 1000,
    bypassed: false,
  };
  source.manifest.tracks[1].fx = {
    type: 'LowPass',
    cutoffHz: 20000,
    bypassed: true,
  };
  const converted = convertSession(source, 8000, () => {});
  expect(converted.fxAdjustments).toEqual([
    { scope: 'Input', previousHz: 15000, cutoffHz: 3600 },
    { scope: 'Track 2', previousHz: 20000, cutoffHz: 3600 },
  ]);
  expect(converted.manifest.tracks[0].fx).toEqual(source.manifest.tracks[0].fx);
  expect(converted.manifest.inputFx).toEqual({
    type: 'LowPass',
    cutoffHz: 3600,
    bypassed: false,
  });
  expect(source.manifest.inputFx.cutoffHz).toBe(15000);
});

async function all(converted: ReturnType<typeof convertSession>, id = 0) {
  const result: number[] = [];
  for (
    let offset = 0;
    offset < converted.manifest.tracks[id].lengthSamples;
    offset += 2048
  )
    result.push(
      ...(await converted.read(
        id,
        offset,
        Math.min(2048, converted.manifest.tracks[id].lengthSamples - offset),
      )),
    );
  return result;
}

test.each([
  [44100, 48000],
  [48000, 44100],
])(
  '1 kHz conversion %i to %i meets RMS tolerance without phase delay',
  async (sourceRate, targetRate) => {
    const source = await fixture(sourceRate, sourceRate / 10, (position) =>
      Math.sin((2 * Math.PI * 1000 * position) / sourceRate),
    );
    const converted = convertSession(source, targetRate, () => {});
    const samples = await all(converted);
    const error = Math.sqrt(
      samples.reduce(
        (sum, sample, i) =>
          sum + (sample - Math.sin((2 * Math.PI * 1000 * i) / targetRate)) ** 2,
        0,
      ) / samples.length,
    );
    expect(error).toBeLessThanOrEqual(0.002);
  },
);

test('rate reduction suppresses a source tone above target Nyquist', async () => {
  const source = await fixture(48000, 4800, (position) =>
    Math.sin((2 * Math.PI * 12000 * position) / 48000),
  );
  const samples = await all(convertSession(source, 16000, () => {}));
  const rms = Math.sqrt(
    samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
  );
  expect(rms).toBeLessThanOrEqual(0.01);
});

test.each([
  [8000, 192000],
  [192000, 8000],
])(
  'boundary conversion %i to %i preserves finite DC and silence',
  async (sourceRate, targetRate) => {
    const source = await fixture(sourceRate, sourceRate / 100, () => -1.5);
    const converted = convertSession(source, targetRate, () => {});
    expect(converted.manifest.cycleLengthSamples).toBe(targetRate / 100);
    for (const value of await converted.read(
      0,
      0,
      Math.min(32, targetRate / 100),
    ))
      expect(value).toBeCloseTo(-1.5, 6);
    const silence = await fixture(sourceRate, sourceRate / 100, () => 0);
    expect(
      await convertSession(silence, targetRate, () => {}).read(1, 0, 32),
    ).toEqual(new Float32Array(32));
  },
);

test('same-rate bypass retains exact samples including finite over-range values', async () => {
  const source = await fixture(48000, 3, (i) => [0.25, -1.5, 0][i]);
  const converted = convertSession(source, 48000, () => {});
  expect(await converted.read(0, 0, 3)).toEqual(
    new Float32Array([0.25, -1.5, 0]),
  );
});

test('tiny recordings that would disappear are rejected before sample processing', async () => {
  const source = await fixture(192000, 1, () => 0.25);
  expect(() => convertSession(source, 8000, () => {})).toThrow(
    'supported length',
  );
});

test('short rounded Loop shares one phase mapping with a peak at the original origin', async () => {
  const source = await fixture(48000, 48, (i) => (i === 0 ? 0.5 : 0));
  const samples = await all(convertSession(source, 44100, () => {}));
  const peak = samples.indexOf(Math.max(...samples));
  expect(peak).toBe(0);
  expect(samples[1]).toBeCloseTo(samples[43], 4);
});

test('conversion yields to cancellation before returning a chunk', async () => {
  const source = await fixture(48000, 4800, () => 0.25);
  let canceled = false;
  const converted = convertSession(source, 44100, () => {
    if (canceled) throw new Error('Canceled');
  });
  const reading = converted.read(0, 0, 2048);
  canceled = true;
  await expect(reading).rejects.toThrow('Canceled');
});

test('two Loops retain identical phase mapping after cycle rounding', async () => {
  const source = await fixture(48000, 48, (i) => (i === 0 ? 0.5 : 0), 48, true);
  const converted = convertSession(source, 44100, () => {});
  expect(converted.manifest.tracks.map((t) => t.lengthSamples)).toEqual([
    44, 44,
  ]);
  expect(await all(converted, 0)).toEqual(await all(converted, 1));
});

test('cancellation during output conversion rejects the next chunk', async () => {
  const source = await fixture(48000, 4800, () => 0.25);
  let canceled = false;
  const converted = convertSession(source, 44100, () => {
    if (canceled) throw new Error('Canceled');
  });
  await converted.read(0, 0, 2048); // Build coefficients and complete the first chunk.
  const reading = converted.read(0, 2048, 2048);
  setTimeout(() => {
    canceled = true;
  }, 0);
  await expect(reading).rejects.toThrow('Canceled');
});
