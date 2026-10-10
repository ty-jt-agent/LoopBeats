import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('suspended context retains completed Loop and requires explicit reinitialization without automatic playback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super(options);
        (window as unknown as { testContext: AudioContext }).testContext = this;
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const track = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(24000);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  const length = await track.getByTestId('loop-length').textContent();
  await page.evaluate(() =>
    (window as unknown as { testContext: AudioContext }).testContext.suspend(),
  );
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio interrupted');
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await expect(track.getByRole('button', { name: /REC\/PLAY/ })).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { testContext: AudioContext }).testContext.resume(),
  );
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio interrupted');
  await page.getByRole('button', { name: 'Reinitialize audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
});
