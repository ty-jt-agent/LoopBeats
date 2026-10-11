import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
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
