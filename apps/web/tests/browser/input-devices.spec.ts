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
  const input = page.getByRole('combobox', { name: 'Input device' });
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
  const input = page.getByRole('combobox', { name: 'Input device' });
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
  const input = page.getByRole('combobox', { name: 'Input device' });
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

test('gated Master configuration survives successful input switching and failed switching', async ({
  page,
}) => {
  test.skip(process.env.VITE_INPUT_FX_PREVIEW !== 'true');
  await page.addInitScript(() => {
    const commands: string[] = [];
    (window as unknown as { inputSwitchCommands: string[] }).inputSwitchCommands =
      commands;
    const OriginalNode = window.AudioWorkletNode;
    window.AudioWorkletNode = new Proxy(OriginalNode, {
      construct(target, args, newTarget) {
        const node = Reflect.construct(target, args, newTarget);
        commands.push('constructed');
        const port = node.port;
        const postMessage = port.postMessage.bind(port);
        port.postMessage = (
          ...messageArgs: Parameters<MessagePort['postMessage']>
        ) => {
          const [message] = messageArgs;
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'stop-transport'
          )
            commands.push(message.type);
          return Reflect.apply(postMessage, port, messageArgs);
        };
        return node;
      },
    });
    const mediaDevices = navigator.mediaDevices;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    let failNext = false;
    mediaDevices.enumerateDevices = async () =>
      ['default', 'usb'].map((deviceId) => ({
        deviceId,
        groupId: 'group',
        kind: 'audioinput' as const,
        label: deviceId === 'usb' ? 'USB interface' : 'Default microphone',
        toJSON() {
          return this;
        },
      }));
    window.addEventListener('fail-next-input-switch', () => {
      failNext = true;
    });
    mediaDevices.getUserMedia = async (constraints) => {
      if (failNext) {
        failNext = false;
        throw new DOMException('Input unavailable', 'NotReadableError');
      }
      const stream = await original({ audio: true });
      const requested = constraints?.audio;
      const requestedId =
        typeof requested === 'object' && requested
          ? requested.deviceId
          : undefined;
      if (
        requestedId &&
        typeof requestedId === 'object' &&
        'exact' in requestedId &&
        typeof requestedId.exact === 'string'
      ) {
        const track = stream.getAudioTracks()[0];
        const getSettings = track.getSettings.bind(track);
        track.getSettings = () => ({
          ...getSettings(),
          deviceId: String(requestedId.exact),
        });
      }
      return stream;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const master = page.getByRole('region', { name: 'Master FX preview' });
  await master.getByRole('button', { name: 'Enable Master filter' }).click();
  await expect(master.getByText('Master: On')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Input device' });
  await input.selectOption('usb');
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('usb');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { inputSwitchCommands: string[] })
            .inputSwitchCommands.filter((type) => type === 'stop-transport')
            .length,
      ),
    )
    .toBe(1);
  await page
    .getByRole('button', { name: 'Close Settings', exact: true })
    .click();
  await expect(master.getByText('Master: On')).toBeVisible();

  await page.evaluate(() =>
    window.dispatchEvent(new Event('fail-next-input-switch')),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await input.selectOption('default');
  await expect(page.getByRole('alert')).toContainText('could not be opened');
  await expect(
    page.evaluate(
      () =>
        (window as unknown as { inputSwitchCommands: string[] })
          .inputSwitchCommands.filter((type) => type === 'stop-transport')
          .length,
    ),
  ).resolves.toBe(1);
  await page
    .getByRole('button', { name: 'Close Settings', exact: true })
    .click();
  await expect(master.getByText('Master: On')).toBeVisible();
});
