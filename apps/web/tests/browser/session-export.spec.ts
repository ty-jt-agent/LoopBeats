import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('downloads a standard ZIP of completed audio while another track is recording', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const exportButton = page.getByRole('button', {
    name: 'Export session',
    exact: true,
  });
  await expect(exportButton).toBeDisabled();
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const tracks = page.locator('.track-strip');
  await expect(
    tracks.nth(0).getByRole('button', { name: /REC\/PLAY/ }),
  ).toBeEnabled();
  await tracks
    .nth(0)
    .getByRole('button', { name: /REC\/PLAY/ })
    .click();
  await page.waitForTimeout(1200);
  await tracks
    .nth(0)
    .getByRole('button', { name: /REC\/PLAY/ })
    .click();
  await expect(tracks.nth(0).getByTestId('track-state')).toHaveText('Playing');
  const length = Number(
    await tracks.nth(0).getByTestId('loop-length').textContent(),
  );
  await tracks
    .nth(1)
    .getByRole('button', { name: /REC\/PLAY/ })
    .click();
  await expect(tracks.nth(1).getByTestId('track-state')).toHaveText(
    'Recording',
  );
  const downloading = page.waitForEvent('download');
  const started = Date.now();
  await exportButton.click();
  await page.evaluate(() => {
    const end = performance.now() + 100;
    while (performance.now() < end) {
      /* reproducible main-thread load */
    }
  });
  const download = await downloading;
  const elapsedMs = Date.now() - started;
  console.log(
    `Export load measurement: ${elapsedMs} ms including 100 ms main-thread load; ${length} frames.`,
  );
  expect(download.suggestedFilename()).toMatch(/^loopbeats-session-.*\.zip$/);
  const path = testInfo.outputPath('session.zip');
  await download.saveAs(path);
  // Python's independent ZIP implementation verifies CRC and central directory.
  const decoded = JSON.parse(
    execFileSync(
      'python',
      [
        '-c',
        `
import json, sys, zipfile, struct
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 m=json.loads(z.read('session.json'))
 w=z.read('tracks/0.wav')
 assert w[:4]==b'RIFF' and w[8:16]==b'WAVEfmt '
 assert struct.unpack_from('<HH',w,20)==(3,1)
 assert w[36:40]==b'fact' and w[48:52]==b'data'
 samples=struct.unpack_from('<'+str((len(w)-56)//4)+'f',w,56)
 print(json.dumps({'manifest':m,'names':z.namelist(),'frames':len(samples),'nonzero':any(samples),'bytes':len(w)}))
`,
        path,
      ],
      { encoding: 'utf8' },
    ),
  );
  expect(decoded.names).toEqual(['session.json', 'tracks/0.wav']);
  console.log(
    `Export source sample rate: ${decoded.manifest.sampleRate} Hz; WAV payload: ${decoded.bytes - 56} bytes.`,
  );
  expect(decoded.frames).toBe(length);
  expect(decoded.bytes).toBe(56 + length * 4);
  expect(decoded.nonzero).toBe(true);
  expect(decoded.manifest.tracks[1]).toMatchObject({
    id: 1,
    lengthSamples: 0,
    audioPath: null,
  });
  expect(decoded.manifest).toMatchObject({
    format: 'LoopBeatsSession',
    version: 1,
    cycleLengthSamples: length,
    masterGain: 1,
  });
  await expect(tracks.nth(0).getByTestId('track-state')).toHaveText('Playing');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  const position = Number(
    await page.getByTestId('transport-position').textContent(),
  );
  await expect
    .poll(async () =>
      Number(await page.getByTestId('transport-position').textContent()),
    )
    .toBeGreaterThan(position);
  await testInfo.attach('export-load-measurement', {
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify({
        sampleRate: decoded.manifest.sampleRate,
        frames: decoded.frames,
        wavBytes: decoded.bytes,
        elapsedMs,
        mainThreadLoadMs: 100,
        playbackContinued: true,
        unfinishedTrackExcluded: true,
      }),
    ),
  });
  await tracks.nth(1).getByRole('button', { name: 'Track STOP' }).click();
  await tracks
    .nth(0)
    .getByRole('button', { name: /REC\/PLAY/ })
    .click();
  await expect(tracks.nth(0).getByTestId('track-state')).toHaveText(
    'Overdubbing',
  );
  await expect(exportButton).toBeDisabled();
});

test('allocation failure leaves the live session intact and export can be retried', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.Blob;
    window.Blob = class extends original {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        if (options?.type === 'application/zip')
          throw new RangeError('Simulated browser allocation failure');
        super(parts, options);
      }
    };
    window.addEventListener('restore-blob', () => {
      window.Blob = original;
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const track = page.locator('.track-strip').nth(0);
  const rec = track.getByRole('button', { name: /REC\/PLAY/ });
  await expect(rec).toBeEnabled();
  await rec.click();
  await page.waitForTimeout(200);
  await rec.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('button', { name: 'Export session', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Not enough memory');
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await page.evaluate(() => window.dispatchEvent(new Event('restore-blob')));
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export session', exact: true })
    .click();
  await download;
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
});

test('worklet export reads exact known samples and rejects changed recordings', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(2, 1024, 48000);
    const module = await WebAssembly.compile(
      await (await fetch('/audio/loop-engine.wasm')).arrayBuffer(),
    );
    await context.audioWorklet.addModule('/audio/processor.js');
    const node = new AudioWorkletNode(context, 'loop-engine', {
      outputChannelCount: [2],
      processorOptions: { module },
    });
    const command = (data: object) =>
      new Promise<Record<string, unknown>>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage(data);
      });
    const input = context.createBuffer(1, 512, 48000);
    for (let i = 0; i < 512; i++)
      input.getChannelData(0)[i] = [0.25, -0.5, 0.75][i % 3];
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(node).connect(context.destination);
    source.start();
    await command({ type: 'record', trackId: 0 });
    const suspended = context.suspend(512 / 48000),
      rendered = context.startRendering();
    await suspended;
    await command({ type: 'record', trackId: 0 });
    const begin = await command({ type: 'export-begin', requestId: 1 });
    const chunk = await command({
      type: 'export-read',
      token: 1,
      requestId: 2,
      trackId: 0,
      offset: 0,
      frames: 512,
    });
    const samples = Array.from(chunk.samples as Float32Array);
    await command({ type: 'clear', trackId: 0 });
    const invalid = await command({
      type: 'export-finish',
      token: 1,
      requestId: 3,
    });
    await context.resume();
    await rendered;
    return { begin, samples, invalid };
  });
  expect(result.samples).toEqual(
    Array.from({ length: 512 }, (_, i) => [0.25, -0.5, 0.75][i % 3]),
  );
  expect(result.begin).not.toHaveProperty('error');
  expect(result.invalid.error).toContain('changed');
});

test('WASM export enforces chunk bounds at the maximum supported recording capacity', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const instance = await WebAssembly.instantiate(
      await (await fetch('/audio/loop-engine.wasm')).arrayBuffer(),
    );
    const e = instance.instance.exports as unknown as Record<
      string,
      (...args: number[]) => number
    > & { memory: WebAssembly.Memory };
    e.initialize(192000);
    const input = new Float32Array(e.memory.buffer, e.input_ptr(), 2048);
    input.fill(0.25);
    const frames = 192000 * 60;
    e.record(0);
    for (let offset = 0; offset < frames; offset += 2048)
      e.process(Math.min(2048, frames - offset));
    const revision = e.recording_revision(0);
    const valid = e.read_recording(0, revision, frames - 2048, 2048);
    const samples = Array.from(
      new Float32Array(e.memory.buffer, e.output_ptr(), 2048),
    );
    return {
      valid,
      samples,
      length: e.loop_length(0),
      oversized: e.read_recording(0, revision, 0, 2049),
      overflow: e.read_recording(0, revision, frames, 1),
    };
  });
  expect(result.length).toBe(11520000);
  expect(result.valid).toBe(1);
  expect(result.samples).toEqual(Array(2048).fill(0.25));
  expect(result.oversized).toBe(0);
  expect(result.overflow).toBe(0);
});

test('a throwing browser port cannot prevent cancellation or a later export', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (
      message: { type?: string },
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (message?.type === 'export-read') return; // Simulate an unanswered browser transfer.
      if (message?.type === 'export-cancel')
        throw new Error('Simulated unavailable browser port');
      Reflect.apply(original, this, [message, transfer ?? []]);
    };
    window.addEventListener('restore-port', () => {
      MessagePort.prototype.postMessage = original;
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const track = page.locator('.track-strip').nth(0);
  const rec = track.getByRole('button', { name: /REC\/PLAY/ });
  await expect(rec).toBeEnabled();
  await rec.click();
  await page.waitForTimeout(200);
  await rec.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const exporting = page.getByRole('button', {
    name: 'Export session',
    exact: true,
  });
  await exporting.click();
  await page.getByRole('button', { name: 'Cancel export' }).click();
  await expect(
    page.getByText('Export canceled.', { exact: true }),
  ).toBeVisible();
  await expect(exporting).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event('restore-port')));
  const downloading = page.waitForEvent('download');
  await exporting.click();
  await downloading;
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
});
