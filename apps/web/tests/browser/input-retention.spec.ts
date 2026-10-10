import { expect, test } from '@playwright/test';

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
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    const state = {
      missing: false,
      delay: false,
      resolve: undefined as (() => void) | undefined,
      replacement: undefined as MediaStream | undefined,
      current: undefined as MediaStream | undefined,
    };
    Object.assign(window, { inputFixture: state });
    media.enumerateDevices = async () =>
      ['default', 'usb'].map((id) => ({
        deviceId: id,
        groupId: 'test',
        kind: 'audioinput' as const,
        label: id,
        toJSON() {
          return this;
        },
      }));
    media.getUserMedia = async (constraints) => {
      const audio = constraints?.audio;
      const constraint = typeof audio === 'object' ? audio.deviceId : undefined;
      const id =
        typeof constraint === 'object' && 'exact' in constraint
          ? String(constraint.exact)
          : 'default';
      if (id === 'usb' && state.missing)
        throw new DOMException('missing USB', 'NotFoundError');
      const stream = await original({ audio: true });
      for (const track of stream.getAudioTracks()) {
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: id });
      }
      state.current = stream;
      if (id === 'usb' && state.delay) {
        state.replacement = stream;
        await new Promise<void>((resolve) => {
          state.resolve = resolve;
        });
      }
      return stream;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
});

test('retry after failed input persistence retains the acknowledged device', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'loopbeats.settings.v1')
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return write.call(this, key, value);
    };
    window.addEventListener('allow-settings-write', () => {
      Storage.prototype.setItem = write;
    });
  });
  await page.getByRole('combobox', { name: 'Audio input' }).selectOption('usb');
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'usb',
  );
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page
    .getByRole('checkbox', { name: 'Confirm before clearing' })
    .uncheck();
  await expect(
    page.getByText('Applied for this visit; could not save in this browser.'),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('allow-settings-write')),
  );
  await expect(
    page.getByText('Saved in this browser.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'usb',
  );
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Confirm before clearing' }),
  ).not.toBeChecked();
});

test('successful selection retains Loop and cycle, saves preference, and restores after reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start audio' }).click();
  const track = page.getByRole('region', { name: /Track 1/ }).first();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(24000);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  const length = await track.getByTestId('loop-length').textContent();
  await page.getByRole('button', { name: 'Global STOP' }).click();
  await expect(page.getByTestId('transport-state')).toHaveText('Stopped');
  await page.getByRole('combobox', { name: 'Audio input' }).selectOption('usb');
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'usb',
  );
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await expect(page.getByTestId('cycle-length')).toHaveText(length!);
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('loopbeats.settings.v1')!)
            .preferredInputId,
      ),
    )
    .toBe('usb');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await page.getByRole('button', { name: 'Stop audio' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'usb',
  );
});

test('unavailable persisted input falls back and displays actual device', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start audio' }).click();
  await page.getByRole('combobox', { name: 'Audio input' }).selectOption('usb');
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'usb',
  );
  await page.getByRole('button', { name: 'Stop audio' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.evaluate(() => {
    (
      window as unknown as { inputFixture: { missing: boolean } }
    ).inputFixture.missing = true;
  });
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'default',
  );
  await expect(
    page.getByText(
      'Preferred input is unavailable; using the system-selected input.',
    ),
  ).toBeVisible();
});

test('Stop audio releases a late replacement stream', async ({ page }) => {
  await page.getByRole('button', { name: 'Start audio' }).click();
  await page.evaluate(() => {
    (
      window as unknown as { inputFixture: { delay: boolean } }
    ).inputFixture.delay = true;
  });
  await page.getByRole('combobox', { name: 'Audio input' }).selectOption('usb');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { inputFixture: { resolve?: () => void } })
            .inputFixture.resolve,
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Stop audio' }).click();
  await page.evaluate(() => {
    (
      window as unknown as { inputFixture: { resolve: () => void } }
    ).inputFixture.resolve();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { inputFixture: { replacement: MediaStream } }
        ).inputFixture.replacement
          .getTracks()
          .every((track) => track.readyState === 'ended'),
      ),
    )
    .toBe(true);
});

test('replacement mute interrupts, recovery keeps device identity, and another switch succeeds', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start audio' }).click();
  await page.getByRole('combobox', { name: 'Audio input' }).selectOption('usb');
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'usb',
  );
  await page.evaluate(() => {
    (
      window as unknown as { inputFixture: { current: MediaStream } }
    ).inputFixture.current
      .getAudioTracks()[0]
      .dispatchEvent(new Event('mute'));
  });
  await expect(
    page.getByRole('button', { name: 'Reinitialize audio' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Reinitialize audio' }).click();
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'usb',
  );
  await page
    .getByRole('combobox', { name: 'Audio input' })
    .selectOption('default');
  await expect(page.getByRole('combobox', { name: 'Audio input' })).toHaveValue(
    'default',
  );
});
