import { expect, test } from '@playwright/test';
import {
  assembleSession,
  type ExportManifest,
} from '../../../../packages/audio-client/src/session-export';
import { parseSession } from '../../../../packages/audio-client/src/session-import';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const original = window.AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super({ sampleRate: 48000, ...options });
      }
    };
  });
});

async function knownSession(length = 3) {
  const manifest: ExportManifest = {
    format: 'LoopBeatsSession',
    version: 1,
    sampleRate: 48000,
    cycleLengthSamples: length,
    masterGain: 0.5,
    tracks: [0, 1].map((id) => ({
      id,
      mode: id ? 'OneShot' : 'Loop',
      gain: id ? 0.25 : 0.75,
      muted: Boolean(id),
      lengthSamples: id ? 2 : length,
      audioPath: `tracks/${id}.wav`,
    })),
  };
  const zip = await assembleSession(
    manifest,
    async (id, offset, frames) =>
      Float32Array.from({ length: frames }, (_, i) =>
        id ? -1.5 : [0.25, -0.5, 0.75][(offset + i) % 3],
      ),
    () => {},
    () => {},
  );
  return {
    name: 'known.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await zip.arrayBuffer()),
  };
}

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByLabel('Import session', { exact: true }),
  ).toBeEnabled();
}
async function saved(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('recovery-status')).toContainText('Saved at', {
    timeout: 15000,
  });
}
async function reloadOffer(page: import('@playwright/test').Page) {
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'View recovery' }).click();
  await expect(
    page.getByRole('button', { name: 'Recover session', exact: true }),
  ).toBeVisible();
}
async function rawExport(page: import('@playwright/test').Page) {
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export session', exact: true })
    .click();
  const file = await download;
  return parseSession(
    Uint8Array.from(await readFile((await file.path())!)).buffer,
    48000,
  );
}

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('Later and live actions preserve the previous workspace until explicit recovery discard', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Recovery available' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(
    page.getByLabel('Import session', { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession(6));
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('6');
  await page
    .getByRole('button', { name: /Stop audio.*discard session/ })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
});

test('failed recovery commit keeps the saved snapshot available for retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let fail = false;
    window.addEventListener('fail-recovery-commit', () => {
      fail = true;
    });
    window.addEventListener('allow-recovery-commit', () => {
      fail = false;
    });
    const original = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends original {
      constructor(
        context: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(context, name, options);
        const post = this.port.postMessage.bind(this.port);
        this.port.postMessage = (
          message: unknown,
          transfer: Transferable[] | StructuredSerializeOptions = [],
        ) => {
          if (fail && (message as { type?: string }).type === 'import-commit')
            throw new Error('Injected commit failure');
          if (Array.isArray(transfer)) post(message, transfer);
          else post(message, transfer);
        };
      }
    };
  });
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('fail-recovery-commit')),
  );
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('transfer failed');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await expect(
    page.getByRole('button', { name: 'Recover session', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('allow-recovery-commit')),
  );
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
});

test('failed atomic checkpoint retains raw audio and settings from the last successful save', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let fail = false;
    window.addEventListener('fail-recovery-write', () => {
      fail = true;
    });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = put.apply(this, args);
      if (fail && this.transaction.db.name === 'loopbeats.recovery.v1')
        queueMicrotask(() => this.transaction.abort());
      return request;
    };
  });
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  await page.evaluate(() =>
    window.dispatchEvent(new Event('fail-recovery-write')),
  );
  await page
    .getByRole('slider', { name: 'Master volume', exact: true })
    .fill('0.8');
  await expect(page.getByTestId('recovery-status')).toContainText('failed');
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Stopped');
  const recovered = await rawExport(page);
  expect(recovered.manifest.masterGain).toBe(0.5);
  expect(
    recovered.manifest.tracks.map((t) => [
      t.mode,
      t.gain,
      t.muted,
      t.lengthSamples,
    ]),
  ).toEqual([
    ['Loop', 0.75, false, 3],
    ['OneShot', 0.25, true, 2],
  ]);
  expect(Array.from(recovered.read(0, 0, 3))).toEqual([0.25, -0.5, 0.75]);
  expect(Array.from(recovered.read(1, 0, 2))).toEqual([-1.5, -1.5]);
});

test('Stop audio discard deletes recovery while ordinary reload retains it', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  await page
    .getByRole('button', { name: /Stop audio.*discard session/ })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('recovery-status')).toContainText(
    'No recovery snapshot',
  );
  await expect(
    page.getByRole('button', { name: 'Recover session', exact: true }),
  ).toHaveCount(0);
});

test('another tab cannot overwrite recovery and offers it after ownership transfers', async ({
  page,
  context,
}) => {
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  const other = await context.newPage();
  await ready(other);
  await expect(other.getByTestId('recovery-status')).toContainText(
    'another tab',
  );
  await other
    .getByRole('slider', { name: 'Master volume', exact: true })
    .fill('0.1');
  await expect(other.getByTestId('recovery-status')).toContainText(
    'another tab',
  );
  await other
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession(6));
  await expect(
    other.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('6');
  await other
    .getByRole('button', { name: /Stop audio.*discard session/ })
    .click();
  await expect(
    other.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await other.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(
    other.getByLabel('Import session', { exact: true }),
  ).toBeEnabled();
  await page.close();
  await other.getByRole('button', { name: 'Retry recovery ownership' }).click();
  await expect(
    other.getByRole('button', { name: 'Recover session', exact: true }),
  ).toBeVisible();
  await other
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(
    other.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
  await expect(
    other.getByRole('slider', { name: 'Master volume', exact: true }),
  ).toHaveValue('0.5');
});

test('CLEAR removes only its recording from the next recovered snapshot', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  const track = page.locator('.track-strip').nth(0);
  await track
    .locator('summary')
    .filter({ hasText: /^Track 1 details$/ })
    .click();
  await track.getByRole('button', { name: 'CLEAR', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: /Clear/ });
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await saved(page);
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await expect(
    page.locator('.track-strip').nth(1).getByTestId('track-state'),
  ).toHaveText('Stopped');
  const recovered = await rawExport(page);
  expect(recovered.manifest.cycleLengthSamples).toBe(3);
  expect(Array.from(recovered.read(1, 0, 2))).toEqual([-1.5, -1.5]);
});

test('completed recording is offered after reload and recovered only on request', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const track = page.locator('.track-strip').nth(0);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await page.waitForTimeout(100);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  const length = await track.getByTestId('loop-length').textContent();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('recovery-status')).toContainText('Saved at', {
    timeout: 15000,
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'View recovery' }).click();
  await expect(
    page.getByRole('button', { name: 'Recover session', exact: true }),
  ).toBeVisible();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
});

test('unfinished One-shot prefix is checkpointed while the completed Loop remains recoverable', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession(48000));
  await saved(page);
  const second = page.locator('.track-strip').nth(1);
  await second
    .locator('summary')
    .filter({ hasText: /^Track 2 details$/ })
    .click();
  await second.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(second.getByTestId('track-state')).toHaveText('Empty');
  await saved(page);
  await page
    .locator('.track-strip')
    .nth(0)
    .getByRole('button', { name: /REC\/PLAY/ })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Playing');
  await second.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(second.getByTestId('track-state')).toHaveText('Recording');
  await page
    .getByRole('slider', { name: 'Master volume', exact: true })
    .fill('0.6');
  await saved(page);
  await expect(second.getByTestId('track-state')).toHaveText('Recording');
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(second.getByTestId('track-state')).toHaveText('Stopped');
  const recovered = await rawExport(page);
  expect(recovered.manifest.tracks[1].lengthSamples).toBeGreaterThan(48000);
  expect(recovered.manifest.masterGain).toBeCloseTo(0.6, 6);
  expect(recovered.manifest.tracks[0].lengthSamples).toBe(48000);
  expect(Array.from(recovered.read(0, 0, 3))).toEqual([0.25, -0.5, 0.75]);
});

test('active overdub checkpoints additions and reload offers stopped partial work', async ({
  page,
}) => {
  await page.addInitScript(() => {
    AudioContext.prototype.createMediaStreamSource = function () {
      const source = this.createConstantSource();
      source.offset.value = 0.125;
      source.start();
      return source as unknown as MediaStreamAudioSourceNode;
    };
  });
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession(48000));
  await saved(page);
  const first = page.locator('.track-strip').nth(0);
  await first.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  await first.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Overdubbing');
  await expect(page.getByTestId('recovery-status')).toContainText(
    'Changes not yet saved.',
  );
  await page
    .getByRole('slider', { name: 'Master volume', exact: true })
    .fill('0.8');
  await expect(page.getByTestId('recovery-status')).toContainText(
    'Changes not yet saved.',
  );
  await saved(page);
  await expect(first.getByTestId('track-state')).toHaveText('Overdubbing');
  await reloadOffer(page);
  await expect(
    page.getByText(/Recovery contains partial recording/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  const recovered = await rawExport(page);
  expect(recovered.manifest.masterGain).toBeCloseTo(0.8, 6);
  expect(recovered.manifest.tracks[0].lengthSamples).toBe(48000);
  expect(Array.from(recovered.read(0, 0, 2048))).not.toEqual(
    Array.from({ length: 2048 }, (_, i) => [0.25, -0.5, 0.75][i % 3]),
  );
});

test('reset checkpoints Empty tracks without resurrecting recordings after reload', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  await page
    .getByRole('button', { name: 'Reset session', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Reset session?' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await saved(page);
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Recover session', exact: true }),
  ).toHaveCount(0);
  const recovered = await rawExport(page);
  expect(recovered.manifest.cycleLengthSamples).toBe(0);
  expect(recovered.manifest.tracks.map((t) => t.lengthSamples)).toEqual([0, 0]);
});

test('global STOP retains initial capture on deletion failure and discards it only after retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let fail = true;
    window.addEventListener('allow-recovery-delete', () => {
      fail = false;
    });
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (
      ...args: Parameters<IDBObjectStore['delete']>
    ) {
      const request = remove.apply(this, args);
      if (fail && this.transaction.db.name === 'loopbeats.recovery.v1')
        queueMicrotask(() => this.transaction.abort());
      return request;
    };
  });
  await ready(page);
  const first = page.locator('.track-strip').nth(0);
  await first.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Recording');
  await saved(page);
  await page.getByRole('button', { name: 'Global STOP', exact: true }).click();
  await expect(page.getByTestId('recovery-status')).toContainText('failed');
  await expect(first.getByTestId('track-state')).toHaveText('Recording');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('allow-recovery-delete')),
  );
  await page.getByRole('button', { name: 'Global STOP', exact: true }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Empty');
  await saved(page);
  await reloadOffer(page);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(first.getByTestId('track-state')).toHaveText('Empty');
  expect((await rawExport(page)).manifest.tracks[0].lengthSamples).toBe(0);
});

test('first Loop recovers its frozen prefix while manual ZIP still omits active initial capture', async ({
  page,
}) => {
  await page.addInitScript(() => {
    AudioContext.prototype.createMediaStreamSource = function () {
      const source = this.createConstantSource();
      source.offset.value = 0.125;
      source.start();
      return source as unknown as MediaStreamAudioSourceNode;
    };
  });
  await ready(page);
  const first = page.locator('.track-strip').nth(0);
  await first.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Recording');
  await saved(page);
  const manual = await rawExport(page);
  expect(manual.manifest.tracks.map((track) => track.lengthSamples)).toEqual([
    0, 0,
  ]);
  await reloadOffer(page);
  await expect(
    page.getByText(/Recovery contains partial recording/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  await expect(page.getByTestId('transport-state')).toHaveText('Stopped');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  const recovered = await rawExport(page);
  const length = recovered.manifest.tracks[0].lengthSamples;
  expect(length).toBeGreaterThan(48000);
  expect(recovered.manifest.cycleLengthSamples).toBe(length);
  expect(Array.from(recovered.read(0, length - 3, 3))).toEqual([
    0.125, 0.125, 0.125,
  ]);
});

test('recovery discard defaults to Cancel and explicitly removes an unsupported record', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('loopbeats.recovery.v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('snapshot');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('snapshot', 'readwrite');
        transaction.objectStore('snapshot').put({ version: 99 }, 'latest');
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error);
        };
      };
    });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unsupported recovery');
  await page
    .getByRole('button', { name: 'Discard recovery', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Discard recovery snapshot?',
  });
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toContainText('unsupported recovery');
  await page
    .getByRole('button', { name: 'Discard recovery', exact: true })
    .click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await saved(page);
});

for (const invalid of [
  { startedAt: 1, captureKinds: ['Unsupported', null] },
  { startedAt: 1, captureKinds: [null] },
  { startedAt: 1, captureKinds: [null, null], sparse: true },
  { startedAt: 1, captureKinds: [null, null], unexpected: 'extra metadata' },
]) {
  test(`invalid recovery checkpoint metadata fails closed: ${JSON.stringify(invalid)}`, async ({
    page,
  }) => {
    await ready(page);
    await saved(page);
    await page.evaluate(async (progress) => {
      const metadata =
        'sparse' in progress
          ? {
              startedAt: progress.startedAt,
              captureKinds: Object.assign(new Array<null>(2), {
                0: null,
                extra: 'invalid',
              }),
            }
          : progress;
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('loopbeats.recovery.v1', 1);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('snapshot', 'readwrite');
          const store = transaction.objectStore('snapshot');
          const read = store.get('latest');
          read.onsuccess = () =>
            store.put({ ...read.result, progress: metadata }, 'latest');
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
        open.onerror = () => reject(open.error);
      });
    }, invalid);
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('unsupported recovery');
    await expect(
      page.getByRole('button', { name: 'Recover session', exact: true }),
    ).toHaveCount(0);
  });
}

test('older completed checkpoint without progress metadata still recovers', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await knownSession());
  await saved(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('loopbeats.recovery.v1', 1);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('snapshot', 'readwrite');
        const store = transaction.objectStore('snapshot');
        const read = store.get('latest');
        read.onsuccess = () => {
          const record = read.result;
          delete record.progress;
          store.put(record, 'latest');
        };
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error);
        };
      };
      open.onerror = () => reject(open.error);
    });
  });
  await reloadOffer(page);
  await expect(
    page.getByText(/Recovery contains partial recording/),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await page
    .getByRole('button', { name: 'Recover session', exact: true })
    .click();
  const recovered = await rawExport(page);
  expect(Array.from(recovered.read(0, 0, 3))).toEqual([0.25, -0.5, 0.75]);
});
