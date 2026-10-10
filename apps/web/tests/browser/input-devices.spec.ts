import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('shows input selection and gates switching during capture', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    mediaDevices.enumerateDevices = async () => [
      {
        deviceId: 'default',
        groupId: 'group',
        kind: 'audioinput',
        label: 'Default microphone',
        toJSON() {
          return this;
        },
      },
      {
        deviceId: 'usb',
        groupId: 'group',
        kind: 'audioinput',
        label: 'USB interface',
        toJSON() {
          return this;
        },
      },
    ];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const input = page.getByRole('combobox', { name: 'Audio input' });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('default');
  await page
    .getByRole('region', { name: /Track 1/ })
    .first()
    .getByRole('button', { name: /REC\/PLAY/ })
    .click();
  await expect(input).toBeDisabled();
});

test('reports a rejected switch and keeps the previous input selected', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.enumerateDevices = async () => [
      {
        deviceId: 'default',
        groupId: 'group',
        kind: 'audioinput',
        label: 'Default',
        toJSON() {
          return this;
        },
      },
      {
        deviceId: 'usb',
        groupId: 'group',
        kind: 'audioinput',
        label: 'USB',
        toJSON() {
          return this;
        },
      },
    ];
    mediaDevices.getUserMedia = async (constraints) => {
      const requested = constraints ?? {};
      const deviceId =
        typeof requested.audio === 'object' && requested.audio
          ? (requested.audio as MediaTrackConstraints).deviceId
          : undefined;
      if (
        deviceId &&
        typeof deviceId === 'object' &&
        'exact' in deviceId &&
        deviceId.exact === 'usb'
      ) {
        throw new DOMException('USB input unavailable', 'NotReadableError');
      }
      return original(constraints);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const input = page.getByRole('combobox', { name: 'Audio input' });
  await input.selectOption('usb');
  await expect(page.getByRole('alert')).toContainText('could not be opened');
  await expect(input).toHaveValue('default');
  const track = page.getByRole('region', { name: /Track 1/ }).first();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(24000);
  await expect(page.getByRole('alert')).toContainText('could not be opened');
});

test('does not replace input when recording begins during a delayed switch', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.enumerateDevices = async () => [
      {
        deviceId: 'default',
        groupId: 'group',
        kind: 'audioinput',
        label: 'Default',
        toJSON() {
          return this;
        },
      },
      {
        deviceId: 'usb',
        groupId: 'group',
        kind: 'audioinput',
        label: 'USB',
        toJSON() {
          return this;
        },
      },
    ];
    mediaDevices.getUserMedia = async (constraints) => {
      const requested = constraints ?? {};
      const deviceId =
        typeof requested.audio === 'object' && requested.audio
          ? (requested.audio as MediaTrackConstraints).deviceId
          : undefined;
      if (
        deviceId &&
        typeof deviceId === 'object' &&
        'exact' in deviceId &&
        deviceId.exact === 'usb'
      ) {
        return new Promise<MediaStream>((resolve) => {
          (
            window as unknown as {
              resolveSwitch: (stream: MediaStream) => void;
            }
          ).resolveSwitch = resolve;
        });
      }
      return original(constraints);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const input = page.getByRole('combobox', { name: 'Audio input' });
  await input.selectOption('usb');
  await expect(
    page.getByRole('button', { name: /REC\/PLAY/ }).first(),
  ).toBeDisabled();
  await page.evaluate(() => {
    const resolve = (
      window as unknown as { resolveSwitch?: (stream: MediaStream) => void }
    ).resolveSwitch;
    if (resolve)
      void navigator.mediaDevices.getUserMedia({ audio: true }).then(resolve);
  });
  await expect(
    page.getByRole('button', { name: /REC\/PLAY/ }).first(),
  ).toBeEnabled();
});
