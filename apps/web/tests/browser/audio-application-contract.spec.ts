import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('the injected Web application applies a command through real WASM at a reported block boundary', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const host = {
      commands: [] as Record<string, unknown>[],
      outcomes: [] as Record<string, unknown>[],
    };
    (
      window as unknown as { audioContractProbe: typeof host }
    ).audioContractProbe = host;
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = new Proxy(NativeNode, {
      construct(target, args, newTarget) {
        const node = Reflect.construct(target, args, newTarget);
        const port = node.port;
        const postMessage = port.postMessage.bind(port);
        port.postMessage = (
          message: unknown,
          options?: Transferable[] | StructuredSerializeOptions,
        ) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'application-command'
          )
            host.commands.push(message as Record<string, unknown>);
          if (Array.isArray(options)) return postMessage(message, options);
          if (options) return postMessage(message, options);
          return postMessage(message);
        };
        port.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as Record<string, unknown>;
          if (typeof data?.commandId === 'number') host.outcomes.push(data);
        });
        return node;
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await page.getByRole('button', { name: 'Enable monitoring' }).click();
  await expect(page.getByText('Monitoring on', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = (
          window as unknown as {
            audioContractProbe: {
              commands: Record<string, unknown>[];
              outcomes: Record<string, unknown>[];
            };
          }
        ).audioContractProbe;
        const command = host.commands.at(-1);
        return (
          command &&
          host.outcomes.some(
            (outcome) => outcome.commandId === command.commandId,
          )
        );
      }),
    )
    .toBe(true);
  const result = await page.evaluate(() => {
    const host = (
      window as unknown as {
        audioContractProbe: {
          commands: Record<string, unknown>[];
          outcomes: Record<string, unknown>[];
        };
      }
    ).audioContractProbe;
    const command = host.commands.at(-1)!;
    return host.outcomes.find(
      (outcome) => outcome.commandId === command.commandId,
    );
  });
  expect(result).toMatchObject({
    status: 'applied',
    generation: expect.any(Number),
  });
  expect(result?.applicationFrame).toEqual(expect.any(Number));
  expect(result?.blockSequence).toEqual(expect.any(Number));
});
