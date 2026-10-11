import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('ZIP controls explain startup availability without starting audio', async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('Settings must not request microphone access');
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save ZIP', exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel('Load ZIP', { exact: true })).toBeDisabled();
  await expect(
    page.getByText('Start audio to use session files.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('status', { name: 'Audio status' })).toHaveText(
    'Audio stopped',
  );
});
