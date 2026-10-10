import { expect, test, type Page } from '@playwright/test';
import {
  assembleSession,
  type ExportManifest,
} from '../../../../packages/audio-client/src/session-export';
import { parseSession } from '../../../../packages/audio-client/src/session-import';
import { readFile } from 'node:fs/promises';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super({ sampleRate: 48000, ...options });
      }
    };
  });
});
async function sourceFile(
  rate = 44100,
  length = 4410,
  oneShotLength = length / 2,
  tone = true,
) {
  const manifest: ExportManifest = {
    format: 'LoopBeatsSession',
    version: 1,
    sampleRate: rate,
    cycleLengthSamples: length,
    masterGain: 0.5,
    tracks: [
      {
        id: 0,
        mode: 'Loop',
        gain: 0.75,
        muted: false,
        lengthSamples: length,
        audioPath: 'tracks/0.wav',
      },
      {
        id: 1,
        mode: 'OneShot',
        gain: 0.25,
        muted: true,
        lengthSamples: oneShotLength,
        audioPath: 'tracks/1.wav',
      },
    ],
  };
  const zip = await assembleSession(
    manifest,
    async (id, offset, frames) =>
      Float32Array.from({ length: frames }, (_, i) =>
        id
          ? -1.5
          : tone
            ? Math.sin((2 * Math.PI * 1000 * (offset + i)) / rate)
            : 0.25,
      ),
    () => {},
    () => {},
  );
  return {
    name: 'session.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  };
}
async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(
    page
      .locator('.track-strip')
      .nth(0)
      .getByRole('button', { name: /REC\/PLAY/ }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}
const conversionDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Convert sample rate?' });
async function consent(page: Page) {
  const dialog = conversionDialog(page);
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Convert session', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
}

test('conversion consent precedes replacement and converted audio replays through real worklet', async ({
  page,
}, testInfo) => {
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await sourceFile(48000, 48, 24, false));
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await input.setInputFiles(await sourceFile());
  await expect(conversionDialog(page)).toContainText('44,100 Hz to 48,000 Hz');
  await expect(conversionDialog(page)).toContainText('may affect fidelity');
  await page.keyboard.press('Escape');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('48');
  await input.setInputFiles(await sourceFile());
  await consent(page);
  const replace = page.getByRole('dialog', {
    name: 'Replace current session?',
  });
  await expect(
    replace.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('48');
  await input.setInputFiles(await sourceFile());
  await consent(page);
  await expect(
    replace.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  const tracks = page.locator('.track-strip');
  await expect(tracks.nth(0).getByTestId('loop-length')).toHaveText('4800');
  await expect(tracks.nth(1).getByTestId('loop-length')).toHaveText('2400');
  for (let id = 0; id < 2; id++)
    await expect(tracks.nth(id).getByTestId('track-state')).toHaveText(
      'Stopped',
    );
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export session', exact: true })
    .click();
  const path = testInfo.outputPath('converted.zip');
  await (await downloading).saveAs(path);
  const bytes = await readFile(path);
  const converted = await parseSession(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.length,
    ) as ArrayBuffer,
    48000,
  );
  expect(converted.manifest).toMatchObject({
    sampleRate: 48000,
    masterGain: 0.5,
    cycleLengthSamples: 4800,
  });
  expect(converted.manifest.tracks[1]).toMatchObject({
    mode: 'OneShot',
    gain: 0.25,
    muted: true,
  });
  const wave: number[] = [];
  for (let offset = 0; offset < 4800; offset += 2048)
    wave.push(...converted.read(0, offset, Math.min(2048, 4800 - offset)));
  const rms = Math.sqrt(
    wave.reduce(
      (sum, sample, i) =>
        sum + (sample - Math.sin((2 * Math.PI * 1000 * i) / 48000)) ** 2,
      0,
    ) / wave.length,
  );
  expect(rms).toBeLessThan(0.002);
  for (const sample of converted.read(1, 0, 128))
    expect(sample).toBeCloseTo(-1.5, 6);
  const playback = await page.evaluate(
    async ({ wave, manifest }) => {
      const context = new OfflineAudioContext(1, 128, 48000);
      const module = await WebAssembly.compile(
        await (await fetch('/audio/loop-engine.wasm')).arrayBuffer(),
      );
      await context.audioWorklet.addModule('/audio/processor.js');
      const node = new AudioWorkletNode(context, 'loop-engine', {
        outputChannelCount: [1],
        processorOptions: { module },
      });
      node.connect(context.destination);
      let sequence = 0;
      const command = (data: Record<string, unknown>) =>
        new Promise<void>((resolve, reject) => {
          const requestId = ++sequence;
          node.port.onmessage = ({ data: reply }) => {
            if (
              data.type?.toString().startsWith('import-')
                ? reply.type === 'import-reply' && reply.requestId === requestId
                : reply.type === 'snapshot'
            ) {
              if (reply.error) {
                reject(new Error(reply.error));
                return;
              }
              resolve();
            }
          };
          node.port.postMessage({ ...data, requestId });
        });
      await command({ type: 'import-begin' });
      await command({ type: 'import-configure', token: 1, manifest });
      for (let id = 0; id < 2; id++) {
        const length = manifest.tracks[id].lengthSamples;
        for (let offset = 0; offset < length; offset += 2048) {
          const count = Math.min(2048, length - offset);
          const samples = id
            ? new Float32Array(count).fill(-1.5)
            : new Float32Array(wave.slice(offset, offset + count));
          await command({
            type: 'import-write',
            token: 1,
            trackId: id,
            offset,
            samples,
          });
        }
      }
      await command({ type: 'import-commit', token: 1 });
      await command({ type: 'play', trackId: 0 });
      return Array.from((await context.startRendering()).getChannelData(0));
    },
    { wave, manifest: converted.manifest },
  );
  for (let i = 0; i < playback.length; i++)
    expect(playback[i]).toBeCloseTo(
      0.375 * Math.sin((2 * Math.PI * 1000 * i) / 48000),
      3,
    );
});

test('coefficient allocation begins only after consent and failure preserves the live session', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.Float64Array;
    let fail = true;
    window.Float64Array = new Proxy(original, {
      construct(target, args) {
        if (fail && typeof args[0] === 'number' && args[0] >= 65536)
          throw new RangeError('Simulated conversion allocation failure');
        return Reflect.construct(target, args);
      },
    });
    window.addEventListener('restore-conversion-memory', () => {
      fail = false;
    });
  });
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await sourceFile(48000, 48, 24, false));
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await input.setInputFiles(await sourceFile());
  await expect(conversionDialog(page)).toBeVisible();
  await expect(page.getByRole('alert')).not.toBeVisible();
  await consent(page);
  await expect(page.getByRole('alert')).toContainText('Not enough memory');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('48');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('restore-conversion-memory')),
  );
  await input.setInputFiles(await sourceFile());
  await consent(page);
  await page
    .getByRole('dialog', { name: 'Replace current session?' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(input).toBeEnabled();
});

test('converts both 60-second tracks into the maximum real AudioClient target capacity', async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await page.addInitScript(() => {
    const original = window.AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sampleRate: 192000 });
      }
    };
  });
  await start(page);
  const began = Date.now();
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await sourceFile(8000, 480000, 480000, false));
  await expect(conversionDialog(page)).toContainText('8,000 Hz to 192,000 Hz');
  await consent(page);
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible({ timeout: 150000 });
  const elapsedMs = Date.now() - began;
  console.log(
    `Maximum converted import: ${elapsedMs} ms; two 60-second tracks, 8 kHz to 192 kHz.`,
  );
  for (let id = 0; id < 2; id++) {
    await expect(
      page.locator('.track-strip').nth(id).getByTestId('loop-length'),
    ).toHaveText('11520000');
    await expect(
      page.locator('.track-strip').nth(id).getByTestId('track-state'),
    ).toHaveText('Stopped');
  }
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  await testInfo.attach('maximum-conversion', {
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify({
        sourceRate: 8000,
        targetRate: 192000,
        framesPerTrack: 11520000,
        elapsedMs,
      }),
    ),
  });
});

test('interruption while conversion consent is open releases the operation without replacement', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super(options);
        window.addEventListener('interrupt-conversion', () => {
          void this.suspend();
        });
      }
    };
  });
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await sourceFile(48000, 48, 24, false));
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await input.setInputFiles(await sourceFile());
  await expect(conversionDialog(page)).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('interrupt-conversion')),
  );
  await expect(conversionDialog(page)).not.toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Import canceled.' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Reinitialize audio', exact: true })
    .click();
  await expect(input).toBeEnabled();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('48');
});

test('canceling active conversion retains the old session and permits retry', async ({
  page,
}) => {
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await sourceFile(48000, 48, 24, false));
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await input.setInputFiles(await sourceFile(8000, 480000, 480000, false));
  await consent(page);
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole('progressbar', { name: 'Session import progress' })
          .getAttribute('value'),
      ),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole('button', { name: 'Cancel import', exact: true })
    .click();
  await expect(input).toBeEnabled();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('48');
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export session', exact: true })
    .click();
  const file = await download;
  const parsed = await parseSession(
    Uint8Array.from(await readFile((await file.path())!)).buffer,
    48000,
  );
  expect(Array.from(parsed.read(0, 0, 48))).toEqual(Array(48).fill(0.25));
  expect(parsed.manifest.masterGain).toBe(0.5);
  await input.setInputFiles(await sourceFile());
  await consent(page);
  await expect(
    page.getByRole('dialog', { name: 'Replace current session?' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeEnabled();
});

test('empty different-rate session requests consent and rounds its retained cycle', async ({
  page,
}) => {
  const manifest: ExportManifest = {
    format: 'LoopBeatsSession',
    version: 1,
    sampleRate: 44100,
    cycleLengthSamples: 441,
    masterGain: 0.5,
    tracks: [0, 1].map((id) => ({
      id,
      mode: 'Loop',
      gain: 0.75,
      muted: false,
      lengthSamples: 0,
      audioPath: null,
    })),
  };
  const zip = await assembleSession(
    manifest,
    async () => new Float32Array(0),
    () => {},
    () => {},
  );
  await start(page);
  await page.getByLabel('Import session', { exact: true }).setInputFiles({
    name: 'empty.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  });
  await consent(page);
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export session', exact: true })
    .click();
  const parsed = await parseSession(
    Uint8Array.from(await readFile((await (await download).path())!)).buffer,
    48000,
  );
  expect(parsed.manifest.cycleLengthSamples).toBe(480);
  expect(parsed.manifest.tracks.map((t) => t.lengthSamples)).toEqual([0, 0]);
});

test('live mutation while conversion consent is open prevents replacement', async ({
  page,
}) => {
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await sourceFile(48000, 48, 24, false));
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await input.setInputFiles(await sourceFile());
  await expect(conversionDialog(page)).toBeVisible();
  await page.evaluate(() => {
    const slider = document.querySelector<HTMLInputElement>(
      '[aria-label="Master volume"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(slider, '0.8');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await consent(page);
  await expect(page.getByRole('alert')).toContainText('changed');
  await expect(input).toBeEnabled();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('48');
  await expect(
    page.getByRole('slider', { name: 'Master volume', exact: true }),
  ).toHaveValue('0.8');
});
