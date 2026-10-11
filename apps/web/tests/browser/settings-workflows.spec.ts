import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('Settings explains unavailable ZIP and input controls without starting audio', async ({
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

test('unavailable recovery shows guidance without unsupported retries', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'locks', { value: undefined }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const recovery = page.getByRole('region', { name: 'Recovery', exact: true });
  await expect(recovery.getByTestId('recovery-status')).toHaveText(
    'Recovery unavailable.',
  );
  await expect(
    recovery.getByText(/Reload to check browser recovery/),
  ).toBeVisible();
  await expect(recovery.getByRole('button')).toHaveCount(0);
  await expect(recovery.getByText(/no maximum loss interval/)).toBeHidden();
  await recovery.getByText('Recovery details', { exact: true }).click();
  await expect(recovery.getByText(/no maximum loss interval/)).toBeVisible();
});

test('owner-held read failure explains paused saving without a fake retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (
      ...args: Parameters<IDBObjectStore['get']>
    ) {
      const request = get.apply(this, args);
      if (this.transaction.db.name === 'loopbeats.recovery.v1')
        queueMicrotask(() => this.transaction.abort());
      return request;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const recovery = page.getByRole('region', { name: 'Recovery', exact: true });
  await expect(recovery.getByTestId('recovery-status')).toHaveText(
    'Recovery could not be checked.',
  );
  await expect(recovery.getByRole('alert')).toBeVisible();
  await expect(
    recovery.getByText(/Current recovery saving is paused/),
  ).toBeVisible();
  await expect(recovery.getByRole('button')).toHaveCount(0);
});
