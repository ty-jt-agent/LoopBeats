import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('restores persisted settings when a new audio session starts', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page.evaluate(() =>
    localStorage.setItem(
      'loopbeats.settings.v1',
      JSON.stringify({
        confirmClearing: false,
        preferredInputId: null,
        masterGain: 0.4,
        tracks: [
          { mode: 'Loop', gain: 0.25, muted: true },
          { mode: 'OneShot', gain: 0.75, muted: false },
        ],
      }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Confirm before clearing' }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(page.getByRole('slider', { name: 'Master volume' })).toHaveValue(
    '0.4',
  );
  await expect(
    page.getByRole('slider', { name: 'Track 1 volume' }),
  ).toHaveValue('0.25');
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Track 2 playback mode' }),
  ).toHaveValue('OneShot');
  await page.getByRole('button', { name: 'Stop audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio stopped');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(page.getByRole('slider', { name: 'Master volume' })).toHaveValue(
    '0.4',
  );
  await expect(
    page.getByRole('slider', { name: 'Track 1 volume' }),
  ).toHaveValue('0.25');
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();
});

test('persists confirmation from a fresh page before audio starts', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  const confirmation = page.getByRole('checkbox', {
    name: 'Confirm before clearing',
  });
  await confirmation.uncheck();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await expect(confirmation).not.toBeChecked();
});

test('restores settings after stopping and starting audio again', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await page
    .getByRole('combobox', { name: 'Track 2 playback mode' })
    .selectOption('OneShot');
  await page.getByRole('button', { name: 'Stop audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio stopped');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(
    page.getByRole('combobox', { name: 'Track 2 playback mode' }),
  ).toHaveValue('OneShot');
  await expect(
    page.getByRole('button', { name: 'Enable monitoring' }),
  ).toBeVisible();
  await expect(page.getByTestId('track-state').first()).toHaveText('Empty');
});

test('beforeunload is canceled while a recording exists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const track = page.getByRole('region', { name: /Track 1/ }).first();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
});
