import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { parseSession } from '../../../../packages/audio-client/src/session-import';
import {
  assembleSession,
  type ExportManifest,
} from '../../../../packages/audio-client/src/session-export';

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
        // Fixture WAVs have a known rate; browser/OS defaults vary (CI uses 44.1 kHz).
        super({ sampleRate: 48000, ...options });
      }
    };
  });
});
async function archive(rate = 48000, length = 3) {
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
        lengthSamples: length === 3 ? 2 : length,
        audioPath: 'tracks/1.wav',
      },
    ],
  };
  const blob = await assembleSession(
    manifest,
    async (id, offset, frames) =>
      Float32Array.from({ length: frames }, (_, i) =>
        id ? -1.5 : [0.25, 0, -0.5][(offset + i) % 3],
      ),
    () => {},
    () => {},
  );
  return {
    name: 'session.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await blob.arrayBuffer()),
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

test('hidden import continues and reopens Session for confirmation without closing Settings on Escape', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      await new Promise<void>((resolve) =>
        window.addEventListener('continue-file-read', () => resolve(), {
          once: true,
        }),
      );
      return read.call(this);
    };
  });
  await start(page);
  const track = page.locator('.track-strip').first();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(12000);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  const length = await track.getByTestId('loop-length').textContent();
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await archive());
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await expect(
    page.getByRole('button', { name: 'View progress' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() =>
    window.dispatchEvent(new Event('continue-file-read')),
  );
  const confirmation = page.getByRole('dialog', {
    name: 'Replace current session?',
  });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).not.toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Session', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
});

test('imports maximum two-track capacity through AudioClient at 192 kHz', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const original = window.AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sampleRate: 192000 });
      }
    };
  });
  await start(page);
  const file = testInfo.outputPath('maximum-session.zip');
  await writeFile(file, (await archive(192000, 11520000)).buffer);
  await page.getByLabel('Import session', { exact: true }).setInputFiles(file);
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible({ timeout: 60000 });
  const tracks = page.locator('.track-strip');
  for (let id = 0; id < 2; id++) {
    await expect(tracks.nth(id).getByTestId('loop-length')).toHaveText(
      '11520000',
    );
    await expect(tracks.nth(id).getByTestId('track-state')).toHaveText(
      'Stopped',
    );
  }
  await expect(page.getByTestId('transport-position')).toHaveText('0');
});

test('canceling staging and changing the session before confirmation leave recordings intact', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = MessagePort.prototype.postMessage;
    let stalled = false;
    MessagePort.prototype.postMessage = function (
      message: { type?: string },
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (stalled && message?.type === 'import-write') return;
      return Reflect.apply(original, this, [message, transfer ?? []]);
    };
    window.addEventListener('stall-import', () => {
      stalled = true;
    });
    window.addEventListener('restore-import', () => {
      stalled = false;
    });
  });
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await archive());
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('stall-import')));
  await input.setInputFiles(await archive(48000, 48000 * 2));
  await page
    .getByRole('button', { name: 'Cancel import', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Import canceled.' }),
  ).toBeVisible();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
  await page.evaluate(() => window.dispatchEvent(new Event('restore-import')));
  await input.setInputFiles(await archive(48000, 4));
  const dialog = page.getByRole('dialog', { name: 'Replace current session?' });
  await expect(dialog).toBeVisible();
  // Snapshot polling is not a mutation. A live mix command at the public UI is.
  await page.evaluate(() => {
    const slider = document.querySelector<HTMLInputElement>(
      '[aria-label="Master volume"]',
    );
    if (!slider) throw new Error('Missing master control');
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(slider, '0.8');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await dialog
    .getByRole('button', { name: 'Replace session', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('changed');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
});

test('imports both tracks stopped with metadata, cancel retains them, replacement is explicit', async ({
  page,
}) => {
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await archive());
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  const tracks = page.locator('.track-strip');
  for (let id = 0; id < 2; id++)
    await expect(tracks.nth(id).getByTestId('track-state')).toHaveText(
      'Stopped',
    );
  await expect(tracks.nth(0).getByTestId('loop-length')).toHaveText('3');
  await expect(tracks.nth(1).getByTestId('loop-length')).toHaveText('2');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await input.setInputFiles(await archive(48000, 4));
  const dialog = page.getByRole('dialog', { name: 'Replace current session?' });
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('status').filter({ hasText: 'Import canceled.' }),
  ).toBeVisible();
  await expect(tracks.nth(0).getByTestId('loop-length')).toHaveText('3');
  await input.setInputFiles(await archive(48000, 4));
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Replace session', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tracks.nth(0).getByTestId('loop-length')).toHaveText('4');
  await expect(tracks.nth(1).getByTestId('loop-length')).toHaveText('4');
});

test('invalid and different-rate files preserve the current recording', async ({
  page,
}) => {
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await archive());
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await input.setInputFiles(await archive(44100));
  await expect(
    page.getByRole('dialog', { name: 'Convert sample rate?' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('status').filter({ hasText: 'Import canceled.' }),
  ).toBeVisible();
  const damaged = await archive();
  damaged.buffer[500] ^= 1;
  await input.setInputFiles(damaged);
  await expect(page.getByRole('alert')).toContainText('Invalid');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('allocation and browser transfer failures preserve tracks and allow retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer,
      send = MessagePort.prototype.postMessage;
    let allocationFault = true,
      portFault = true;
    File.prototype.arrayBuffer = async function () {
      if (allocationFault) throw new RangeError('Simulated allocation failure');
      return read.call(this);
    };
    MessagePort.prototype.postMessage = function (
      message: { type?: string },
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (
        portFault &&
        ['import-write', 'import-cancel'].includes(message?.type ?? '')
      )
        throw new Error('Simulated failed browser port');
      return Reflect.apply(send, this, [message, transfer ?? []]);
    };
    window.addEventListener('restore-allocation', () => {
      allocationFault = false;
    });
    window.addEventListener('restore-import-port', () => {
      portFault = false;
    });
    window.addEventListener('break-import-port', () => {
      portFault = true;
    });
  });
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await archive());
  await expect(page.getByRole('alert')).toContainText('Not enough memory');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('restore-allocation')),
  );
  // Restore cancellation delivery so the deliberately lost first cancel cannot own the next operation.
  await page.evaluate(() =>
    window.dispatchEvent(new Event('restore-import-port')),
  );
  await input.setInputFiles(await archive());
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('break-import-port')),
  );
  await input.setInputFiles(await archive(48000, 4));
  await expect(page.getByRole('alert')).toContainText('transfer failed');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('restore-import-port')),
  );
  await input.setInputFiles(await archive(48000, 4));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Replace session', exact: true })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('4');
});

test('AudioClient export/import round trip preserves both raw recordings and settings', async ({
  page,
}, testInfo) => {
  await start(page);
  const original = await archive();
  const expected = await parseSession(
    original.buffer.buffer.slice(
      original.buffer.byteOffset,
      original.buffer.byteOffset + original.buffer.length,
    ) as ArrayBuffer,
    48000,
  );
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(original);
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  for (let pass = 0; pass < 2; pass++) {
    const downloading = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export session', exact: true })
      .click();
    const download = await downloading;
    const path = testInfo.outputPath(`roundtrip-${pass}.zip`);
    await download.saveAs(path);
    const file = await readFile(path);
    const actual = await parseSession(
      file.buffer.slice(
        file.byteOffset,
        file.byteOffset + file.length,
      ) as ArrayBuffer,
      48000,
    );
    expect(actual.manifest).toEqual(expected.manifest);
    expect(actual.read(0, 0, 3)).toEqual(new Float32Array([0.25, 0, -0.5]));
    expect(actual.read(1, 0, 2)).toEqual(new Float32Array([-1.5, -1.5]));
    if (pass === 0) {
      await input.setInputFiles(path);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Replace session', exact: true })
        .click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Session imported.' }),
      ).toBeVisible();
    }
  }
});

test('interruption closes replacement confirmation and releases the import operation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super(options);
        window.addEventListener('interrupt-import-audio', () => {
          void this.suspend();
        });
      }
    };
  });
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await archive());
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await input.setInputFiles(await archive(48000, 4));
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('interrupt-import-audio')),
  );
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Import canceled.' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Reinitialize audio', exact: true })
    .click();
  await expect(input).toBeEnabled();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('3');
  await input.setInputFiles(await archive(48000, 4));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Replace session', exact: true })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('loop-length'),
  ).toHaveText('4');
});

test('real worklet transaction restores exact known samples without partial mutation', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 256, 48000);
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
      new Promise<Record<string, unknown>>((resolve) => {
        const requestId = ++sequence;
        node.port.onmessage = ({ data: reply }) => {
          if (
            data.type?.toString().startsWith('import-')
              ? reply.type === 'import-reply' && reply.requestId === requestId
              : reply.type === 'snapshot'
          )
            resolve(reply);
        };
        node.port.postMessage({ ...data, requestId });
      });
    await command({ type: 'import-begin' });
    const manifest = {
      sampleRate: 48000,
      cycleLengthSamples: 3,
      masterGain: 1,
      tracks: [
        { lengthSamples: 3, mode: 'Loop', gain: 1, muted: false },
        { lengthSamples: 2, mode: 'OneShot', gain: 1, muted: true },
      ],
    };
    await command({ type: 'import-configure', token: 1, manifest });
    await command({
      type: 'import-write',
      token: 1,
      trackId: 0,
      offset: 0,
      samples: new Float32Array([0.25, -0.5, 0.75]),
    });
    const incomplete = await command({ type: 'import-commit', token: 1 });
    const before = await command({ type: 'snapshot' });
    const begin = sequence + 1;
    await command({ type: 'import-begin' });
    await command({ type: 'import-configure', token: begin, manifest });
    const stale = await command({
      type: 'import-write',
      token: 1,
      trackId: 0,
      offset: 0,
      samples: new Float32Array([0.5]),
    });
    node.port.postMessage({ type: 'import-cancel', token: 1 });
    await command({
      type: 'import-write',
      token: begin,
      trackId: 0,
      offset: 0,
      samples: new Float32Array([0.25, -0.5, 0.75]),
    });
    await command({
      type: 'import-write',
      token: begin,
      trackId: 1,
      offset: 0,
      samples: new Float32Array([-1.5, 0.125]),
    });
    await command({ type: 'import-commit', token: begin });
    const stopped = await command({ type: 'snapshot' });
    await command({ type: 'play', trackId: 0 });
    const suspended = context.suspend(128 / 48000),
      rendering = context.startRendering();
    await suspended;
    await command({ type: 'stop-track', trackId: 0 });
    await command({ type: 'set-track-mute', trackId: 1, muted: false });
    await command({ type: 'play', trackId: 1 });
    await context.resume();
    const rendered = await rendering;
    return {
      incomplete,
      before,
      stopped,
      stale,
      samples: Array.from(rendered.getChannelData(0).slice(0, 6)),
      oneShot: Array.from(rendered.getChannelData(0).slice(128, 132)),
    };
  });
  expect(result.incomplete.error).toContain('incomplete');
  expect(result.stale.error).toContain('changed');
  expect(
    (result.before.tracks as { state: string }[]).map((t) => t.state),
  ).toEqual(['Empty', 'Empty']);
  expect(
    (result.stopped.tracks as { state: string }[]).map((t) => t.state),
  ).toEqual(['Stopped', 'Stopped']);
  expect(result.samples).toEqual([0.25, -0.5, 0.75, 0.25, -0.5, 0.75]);
  expect(result.oneShot).toEqual([-1, 0.125, 0, 0]);
});

test('oversized file is rejected before reading or transferring audio', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    File.prototype.arrayBuffer = async () => {
      throw new Error('Unexpected file read');
    };
  });
  const path = testInfo.outputPath('oversized.zip');
  const file = await open(path, 'w');
  try {
    await file.truncate(96 * 1024 * 1024 + 1);
  } finally {
    await file.close();
  }
  await start(page);
  await page.getByLabel('Import session', { exact: true }).setInputFiles(path);
  await expect(page.getByRole('alert')).toContainText('exceeds 96 MiB');
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
});

test('timed-out staging releases the operation and permits retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    let stall = true;
    MessagePort.prototype.postMessage = function (
      message: { type?: string },
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (stall && message?.type === 'import-write') {
        document.body.dataset.importStalled = 'yes';
        return;
      }
      return Reflect.apply(send, this, [message, transfer ?? []]);
    };
    window.addEventListener('restore-timeout-port', () => {
      stall = false;
    });
  });
  await start(page);
  await page.clock.install();
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await archive());
  await expect
    .poll(async () => {
      await page.clock.runFor(100);
      return page.evaluate(() => document.body.dataset.importStalled);
    })
    .toBe('yes');
  await page.clock.fastForward(30001);
  await expect(page.getByRole('alert')).toContainText('timed out');
  await expect(input).toBeEnabled();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('restore-timeout-port')),
  );
  await input.setInputFiles(await archive());
  await expect
    .poll(async () => {
      await page.clock.runFor(100);
      return page
        .getByRole('status')
        .filter({ hasText: 'Session imported.' })
        .count();
    })
    .toBe(1);
});

test('Stop audio during commit dispatch settles import without stale success', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    let teardown = false;
    MessagePort.prototype.postMessage = function (
      message: { type?: string },
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (teardown && message?.type === 'import-commit') {
        const stop = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.includes('Stop audio'),
        );
        stop?.click();
        return;
      }
      return Reflect.apply(send, this, [message, transfer ?? []]);
    };
    window.addEventListener('teardown-import', () => {
      teardown = true;
    });
  });
  await start(page);
  await page.evaluate(() => window.dispatchEvent(new Event('teardown-import')));
  await page
    .getByLabel('Import session', { exact: true })
    .setInputFiles(await archive());
  await expect(
    page.getByRole('alert').filter({ hasText: 'Import canceled.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'Session import progress' }),
  ).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start audio', exact: true }),
  ).toBeEnabled();
});

test('canceling an unanswered file read releases import immediately', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    let stall = true;
    File.prototype.arrayBuffer = function () {
      if (stall) return new Promise<ArrayBuffer>(() => {});
      return read.call(this);
    };
    window.addEventListener('restore-file-read', () => {
      stall = false;
    });
  });
  await start(page);
  const input = page.getByLabel('Import session', { exact: true });
  await input.setInputFiles(await archive());
  await page
    .getByRole('button', { name: 'Cancel import', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Import canceled.' }),
  ).toBeVisible();
  await expect(input).toBeEnabled();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('restore-file-read')),
  );
  await input.setInputFiles(await archive());
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
});
