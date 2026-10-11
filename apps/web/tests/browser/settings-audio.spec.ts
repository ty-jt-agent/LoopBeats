import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('Audio explains disabled input without starting audio', async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('Settings must not request microphone access');
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Input device' }),
  ).toBeDisabled();
  await expect(
    page.getByText('Start audio to choose an input.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('status', { name: 'Audio status' })).toHaveText(
    'Audio stopped',
  );
});

test('an empty input list disables selection while retaining the acknowledged input', async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.enumerateDevices = async () => [];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Audio status' })).toHaveText(
    'Audio ready',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Input device' }),
  ).toBeDisabled();
  await expect(
    page.getByText(/No available input devices were listed/),
  ).toBeVisible();
  await expect(
    page.getByText('Current input: System-selected input', { exact: true }),
  ).toBeVisible();
});
