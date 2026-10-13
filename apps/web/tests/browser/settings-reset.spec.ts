import { expect, test } from '@playwright/test';
import {
  assembleSession,
  type ExportManifest,
} from '../../../../packages/audio-client/src/session-export';
import { selectFxScope } from './fx-editor-helpers';
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

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
  await expect(page.locator('input[type=file]')).toBeEnabled();
}
async function saved(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('recovery-status')).toContainText('Saved at', {
    timeout: 15000,
  });
}

test('reset restores changed FX defaults in an empty session without stopping audio', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');

  await page.getByRole('button', { name: 'Open Input effects' }).click();
  const editor = page.locator('#fx-editor');
  for (const scope of ['Input', 'Track 1', 'Track 2', 'Master'] as const) {
    await selectFxScope(editor, scope);
    const cutoff = editor.getByRole('slider', { name: `${scope} cutoff` });
    await cutoff.fill('500');
    await expect(cutoff).not.toHaveValue('1000');
    await editor
      .getByRole('button', { name: `Enable ${scope} filter` })
      .click();
    await expect(
      editor.getByRole('button', { name: `Bypass ${scope} filter` }),
    ).toBeEnabled();
  }

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const reset = page.getByRole('button', {
    name: 'Reset session',
    exact: true,
  });
  await expect(reset).toBeEnabled();
  await reset.click();
  await page
    .getByRole('dialog', { name: 'Reset session?' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();

  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  for (const scope of ['Input', 'Track 1', 'Track 2', 'Master'] as const) {
    await selectFxScope(editor, scope);
    await expect(editor.getByLabel(`${scope} effect`)).toHaveValue('LowPass');
    await expect(
      editor.getByRole('button', { name: `Enable ${scope} filter` }),
    ).toBeEnabled();
    await expect(
      editor.getByRole('slider', { name: `${scope} cutoff` }),
    ).toHaveValue('1000');
  }
});

for (const width of [1280, 320]) {
  test(`reset deletion failure retains recordings and retries after confirmation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      let fail = false;
      window.addEventListener('fail-recovery-delete', () => {
        fail = true;
      });
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
    await page.locator('input[type=file]').setInputFiles(await knownSession());
    await saved(page);
    await page.evaluate(() =>
      window.dispatchEvent(new Event('fail-recovery-delete')),
    );
    const reset = page.getByRole('button', {
      name: 'Reset session',
      exact: true,
    });
    await page.screenshot({
      path: testInfo.outputPath('session-settings.png'),
    });
    await reset.click();
    const confirmation = page.getByRole('dialog', { name: 'Reset session?' });
    await expect(
      confirmation.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    await expect(confirmation.getByText(/owned recovery copy/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('reset-confirmation.png'),
    });
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('tab', { name: 'Session', exact: true }),
    ).toBeVisible();
    await expect(reset).toBeFocused();
    await reset.click();
    await confirmation
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    await expect(
      page.getByText(/Recordings remain unchanged. Retry Reset/),
    ).toBeVisible();
    await expect(
      page.locator('.track-strip').nth(0).getByTestId('track-state'),
    ).toHaveText('Stopped');
    await expect(reset).toBeFocused();
    if (width === 1280) {
      await page.getByRole('button', { name: 'Close Settings' }).click();
      const first = page.locator('.track-strip').nth(0);
      await first.getByText('Track 1 details', { exact: true }).click();
      await first.getByRole('button', { name: 'CLEAR', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Clear Track 1?' })
        .getByRole('button', { name: 'Confirm', exact: true })
        .click();
      await expect(first.getByRole('alert')).toContainText(
        'Retry CLEAR on Track 1',
      );
      await expect(first.getByTestId('track-state')).toHaveText('Stopped');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(
        page
          .getByRole('region', { name: 'Remove recordings', exact: true })
          .getByRole('alert'),
      ).toHaveCount(0);
    }
    await page.evaluate(() =>
      window.dispatchEvent(new Event('allow-recovery-delete')),
    );
    await reset.click();
    await expect(
      confirmation.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    await confirmation
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    await expect(
      page.locator('.track-strip').nth(0).getByTestId('track-state'),
    ).toHaveText('Empty');
    await expect(page.getByTestId('transport-position')).toHaveText('0');
    await expect(
      page.getByText('Monitoring off', { exact: true }),
    ).toBeVisible();
  });
}
