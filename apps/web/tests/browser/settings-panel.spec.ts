import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('export keeps running across groups, dismissal and responsive transitions', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const post = MessagePort.prototype.postMessage;
    const pending: { port: MessagePort; args: unknown[] }[] = [];
    MessagePort.prototype.postMessage = function (...args) {
      if (args[0]?.type === 'export-read') {
        pending.push({ port: this, args });
        return;
      }
      Reflect.apply(post, this, args);
    };
    window.addEventListener('continue-export', () => {
      MessagePort.prototype.postMessage = post;
      pending.forEach(({ port, args }) => Reflect.apply(post, port, args));
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const track = page.locator('.track-strip').first();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(12000);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('button', { name: 'Export session', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Cancel export' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await page.setViewportSize({ width: 640, height: 400 });
  await page.getByRole('button', { name: 'View progress' }).click();
  await expect(
    page.getByRole('tab', { name: 'Session', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('button', { name: 'Cancel export' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.dispatchEvent(new Event('continue-export')));
  await download;
  await expect(
    page.getByRole('status').filter({ hasText: 'Session ZIP downloaded.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'View progress' }).click();
  await expect(
    page.getByText('Session ZIP downloaded.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
});

test('Settings groups remember this visit and preferences persist before startup', async ({
  page,
}) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Settings', exact: true });
  await trigger.click();
  await expect(
    page.getByRole('tab', { name: 'Session', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Preferences' })).toBeFocused();
  const preference = page.getByRole('checkbox', {
    name: 'Confirm before clearing',
  });
  await preference.uncheck();
  await expect(
    page.getByText('Saved in this browser.', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.getByRole('tab', { name: 'Preferences' })).toBeFocused();
  await expect(preference).not.toBeChecked();
  await page.reload();
  await trigger.click();
  await expect(
    page.getByRole('tab', { name: 'Session', exact: true }),
  ).toBeFocused();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await expect(preference).not.toBeChecked();
});

test('preference retry during interruption saves retained current mix', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = AudioContext;
    window.AudioContext = class extends original {
      constructor(options?: AudioContextOptions) {
        super(options);
        (
          window as unknown as { settingsContext: AudioContext }
        ).settingsContext = this;
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
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
  await page.getByRole('slider', { name: 'Master volume' }).fill('0.4');
  await page.getByRole('slider', { name: 'Track 1 volume' }).fill('0.25');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page
    .getByRole('checkbox', { name: 'Confirm before clearing' })
    .uncheck();
  await expect(
    page.getByText('Applied for this visit; could not save in this browser.'),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { settingsContext: AudioContext }
    ).settingsContext.suspend(),
  );
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio interrupted');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('allow-settings-write')),
  );
  await page.getByRole('button', { name: 'Retry saving preferences' }).click();
  await expect(
    page.getByText('Saved in this browser.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Master volume' })).toHaveValue(
    '0.4',
  );
  await expect(
    page.getByRole('slider', { name: 'Track 1 volume' }),
  ).toHaveValue('0.25');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Confirm before clearing' }),
  ).not.toBeChecked();
});

test('failed preference saving keeps the visit value and retries current choices', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key === 'loopbeats.settings.v1' &&
        !(window as unknown as { allowPreferenceWrite: boolean })
          .allowPreferenceWrite
      )
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  const checkbox = page.getByRole('checkbox', {
    name: 'Confirm before clearing',
  });
  await checkbox.uncheck();
  await expect(
    page.getByText('Applied for this visit; could not save in this browser.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await page.evaluate(() => {
    (
      window as unknown as { allowPreferenceWrite: boolean }
    ).allowPreferenceWrite = true;
  });
  await page.getByRole('button', { name: 'Retry saving preferences' }).click();
  await expect(
    page.getByText('Saved in this browser.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await expect(checkbox).not.toBeChecked();
});

test('responsive Settings contains focus without stopping actual capture or playback', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const track = page.locator('.track-strip').first();
  const record = track.getByRole('button', { name: /REC\/PLAY/ });
  await record.click();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page
    .getByRole('checkbox', { name: 'Confirm before clearing' })
    .uncheck();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(12000);
  await page.setViewportSize({ width: 1023, height: 700 });
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#performance-shell')).toHaveAttribute('inert', '');
  const close = panel.getByRole('button', { name: 'Close Settings' });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(panel.getByRole('checkbox')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeFocused();
  await record.click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Settings', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await track.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await page.getByRole('button', { name: 'Close Settings' }).click();
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 640, height: 400 },
]) {
  test(`Settings fits ${viewport.width}px and reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const group of ['Session', 'Audio', 'Preferences']) {
      await page.getByRole('tab', { name: group, exact: true }).click();
      for (const control of await page
        .getByRole('dialog', { name: 'Settings', exact: true })
        .locator('button, input, select')
        .all()) {
        if (!(await control.isVisible())) continue;
        await control.scrollIntoViewIfNeeded();
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    }
    await expect(
      page.getByRole('button', { name: 'Close Settings' }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
