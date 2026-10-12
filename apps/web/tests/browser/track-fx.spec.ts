import { expect, test } from '@playwright/test';
import {
  assembleSession,
  type ExportManifest,
} from '../../../../packages/audio-client/src/session-export';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('ordinary production keeps Track FX previews gated', async ({ page }) => {
  test.skip(process.env.VITE_INPUT_FX_PREVIEW === 'true');
  await page.goto('/?trackFxPreview=true');
  await expect(
    page.getByRole('region', { name: 'Track 1 FX preview' }),
  ).toHaveCount(0);
});

test('gated independent Track controls acknowledge edits, bypass and removal with reachable playback', async ({
  page,
}) => {
  test.skip(process.env.VITE_INPUT_FX_PREVIEW !== 'true');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const one = page.getByRole('region', { name: 'Track 1 FX preview' });
  const two = page.getByRole('region', { name: 'Track 2 FX preview' });
  await expect(
    one.getByRole('button', { name: 'Enable Track 1 filter' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(
    one.getByRole('button', { name: 'Enable Track 1 filter' }),
  ).toBeEnabled();
  await one.getByRole('slider', { name: 'Track 1 cutoff' }).fill('500');
  await expect(one.getByRole('slider', { name: 'Track 1 cutoff' })).toHaveValue(
    '500',
  );
  await one.getByRole('button', { name: 'Enable Track 1 filter' }).click();
  await expect(
    one.getByRole('button', { name: 'Bypass Track 1 filter' }),
  ).toBeEnabled();
  await expect(two.getByRole('slider', { name: 'Track 2 cutoff' })).toHaveValue(
    '1000',
  );
  await page
    .getByRole('button', { name: /Track 1 REC\/PLAY.*Record$/ })
    .click();
  await page
    .getByRole('button', { name: /Track 1 REC\/PLAY.*Finish recording$/ })
    .click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Playing');
  await one.getByRole('slider', { name: 'Track 1 cutoff' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(one.getByRole('slider', { name: 'Track 1 cutoff' })).toHaveValue(
    '501',
  );
  await one.getByRole('button', { name: 'Bypass Track 1 filter' }).click();
  await one
    .getByRole('combobox', { name: 'Track 1 effect' })
    .selectOption('None');
  await expect(
    one.getByRole('combobox', { name: 'Track 1 effect' }),
  ).toHaveValue('None');
  await expect(
    one.getByRole('combobox', { name: 'Track 1 effect' }),
  ).toBeEnabled();
  await one
    .getByRole('combobox', { name: 'Track 1 effect' })
    .selectOption('LowPass');
  await expect(
    one.getByRole('button', { name: 'Enable Track 1 filter' }),
  ).toBeEnabled();
  await expect(two).toContainText('Track 2: Bypassed');
  const box = await one
    .getByRole('button', { name: 'Enable Track 1 filter' })
    .boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});

test('real worklet filters Track playback independently, preserves raw audio and clears One-shot after its final sample', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rate = 48000,
      context = new OfflineAudioContext(1, 512, rate);
    await context.audioWorklet.addModule('/audio/processor.js');
    const module = await WebAssembly.compile(
      await (await fetch('/audio/loop-engine.wasm')).arrayBuffer(),
    );
    const node = new AudioWorkletNode(context, 'loop-engine', {
      processorOptions: { module },
      outputChannelCount: [1],
    });
    let sequence = 0;
    const command = (data: object, expected = 'snapshot') =>
      new Promise<Record<string, unknown>>((resolve) => {
        node.port.onmessage = ({ data: reply }) => {
          if (reply.type === expected) resolve(reply);
        };
        node.port.postMessage(data);
      });
    await command({ type: 'set-mode', trackId: 0, mode: 'OneShot' });
    await command({ type: 'record', trackId: 0 });
    const buffer = context.createBuffer(1, 512, rate);
    buffer.getChannelData(0)[0] = 0.5;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(node).connect(context.destination);
    source.start();
    const suspended = context.suspend(128 / rate),
      second = context.suspend(256 / rate);
    const render = context.startRendering();
    await suspended;
    await command({ type: 'record', trackId: 0 });
    await command(
      {
        type: 'set-playback-fx',
        scope: 1,
        requestId: ++sequence,
        config: { type: 'LowPass', cutoffHz: 1000, bypassed: false },
      },
      'playback-fx-reply',
    );
    await command({ type: 'stop-track', trackId: 0 });
    await command({ type: 'play', trackId: 0 });
    const begin = ++sequence;
    const exported = await command(
      { type: 'export-begin', requestId: begin },
      'export-reply',
    );
    const raw = await command(
      {
        type: 'export-read',
        requestId: ++sequence,
        token: begin,
        trackId: 0,
        offset: 0,
        frames: 128,
      },
      'export-reply',
    );
    await command(
      { type: 'export-finish', requestId: ++sequence, token: begin },
      'export-reply',
    );
    await context.resume();
    await second;
    const stopped = await command({ type: 'snapshot' });
    await command({ type: 'play', trackId: 0 });
    await context.resume();
    const samples = (await render).getChannelData(0);
    const rejected = await command(
      {
        type: 'set-playback-fx',
        scope: 1,
        requestId: sequence + 1,
        config: { type: 'LowPass', cutoffHz: NaN, bypassed: true },
      },
      'playback-fx-reply',
    );
    return {
      output: [...samples.slice(128, 132)],
      retrigger: [...samples.slice(256, 260)],
      afterEnd: [...samples.slice(384)],
      raw: [...(raw.samples as Float32Array)],
      stopped,
      exported,
      rejected,
    };
  });
  for (const [id, expected] of [
    0.00195806333027369, 0.00747067946653054, 0.01389273310983166,
    0.01901187277242247,
  ].entries())
    expect(result.output[id]).toBeCloseTo(expected, 7);
  expect(result.retrigger).toEqual(result.output);
  expect(result.afterEnd.every((s) => s === 0)).toBe(true);
  expect(result.raw).toEqual([0.5, ...Array(127).fill(0)]);
  expect((result.stopped.tracks as { state: string }[])[0].state).toBe(
    'Stopped',
  );
  expect((result.stopped.fx as { config: object }[])[2].config).toMatchObject({
    bypassed: true,
  });
  expect(result.rejected.error).toContain('Invalid FX');
});

test('gated Track command queue keeps the latest edit, exposes rejection and resets ownership on Stop audio', async ({
  page,
}) => {
  test.skip(process.env.VITE_INPUT_FX_PREVIEW !== 'true');
  await page.addInitScript(() => {
    const send = MessagePort.prototype.postMessage;
    let invalid = true;
    MessagePort.prototype.postMessage = function (
      message,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (message?.type === 'set-playback-fx') {
        const modified = invalid
          ? {
              ...message,
              config: { type: 'LowPass', cutoffHz: -1, bypassed: false },
            }
          : message;
        invalid = false;
        setTimeout(
          () => Reflect.apply(send, this, [modified, transfer ?? []]),
          50,
        );
        return;
      }
      return Reflect.apply(send, this, [message, transfer ?? []]);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const one = page.getByRole('region', { name: 'Track 1 FX preview' });
  const slider = one.getByRole('slider', { name: 'Track 1 cutoff' });
  await expect(slider).toBeEnabled();
  await slider.fill('300');
  await expect(one.getByRole('alert')).toContainText('Invalid FX');
  await expect(slider).toHaveValue('1000');
  await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    for (let value = 400; value <= 450; value++) {
      set.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await expect(slider).toHaveValue('450');
  await expect(one.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Track 2 FX preview' }),
  ).toContainText('Track 2: Bypassed');
  await page
    .getByRole('button', { name: 'Stop audio — discard session' })
    .click();
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue('1000');
  await expect(
    one.getByRole('button', { name: 'Enable Track 1 filter' }),
  ).toBeEnabled();
});

test('gated import cannot replace a workspace while an acknowledged FX reply and queued target are outstanding', async ({
  page,
}) => {
  test.skip(process.env.VITE_INPUT_FX_PREVIEW !== 'true');
  await page.addInitScript(() => {
    const Original = window.AudioWorkletNode;
    const onmessage = Object.getOwnPropertyDescriptor(
      MessagePort.prototype,
      'onmessage',
    );
    if (!onmessage?.get || !onmessage.set)
      throw new Error('MessagePort.onmessage is unavailable');
    window.AudioWorkletNode = class extends Original {
      constructor(
        context: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(context, name, options);
        const port = this.port;
        Object.defineProperty(port, 'onmessage', {
          configurable: true,
          get: () => onmessage!.get!.call(port),
          set: (handler: typeof port.onmessage) =>
            onmessage!.set!.call(
              port,
              handler &&
                function (this: MessagePort, event: MessageEvent) {
                  if (event.data?.type === 'playback-fx-reply') {
                    window.dispatchEvent(new Event('held-playback-fx-reply'));
                    window.addEventListener(
                      'deliver-playback-fx-reply',
                      () => handler.call(this, event),
                      { once: true },
                    );
                    return;
                  }
                  handler.call(this, event);
                },
            ),
        });
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Track 1 cutoff' });
  await expect(slider).toBeEnabled();
  const heldReply = page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        window.addEventListener('held-playback-fx-reply', () => resolve(), {
          once: true,
        }),
      ),
  );
  await slider.fill('300');
  await heldReply;
  await slider.fill('400'); // Intent remains queued until the public reply is delivered.
  await expect(
    page.getByRole('status').filter({ hasText: 'FX command pending' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const manifest: ExportManifest = {
    format: 'LoopBeatsSession',
    version: 1,
    sampleRate: 48000,
    cycleLengthSamples: 0,
    masterGain: 1,
    tracks: [0, 1].map((id) => ({
      id,
      mode: 'Loop',
      gain: 1,
      muted: false,
      lengthSamples: 0,
      audioPath: null,
    })),
  };
  const blob = await assembleSession(
    manifest,
    async () => new Float32Array(),
    () => {},
    () => {},
  );
  await page.getByLabel('Load ZIP', { exact: true }).setInputFiles({
    name: 'empty.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await blob.arrayBuffer()),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: 'FX edits are still pending' }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('deliver-playback-fx-reply')),
  );
  // The queued edit still belongs to the unchanged workspace and is accepted there.
  await expect(slider).toHaveValue('400');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('deliver-playback-fx-reply')),
  );
  await expect(
    page.getByRole('region', { name: 'Track 1 FX preview' }),
  ).toContainText('target acknowledged');
  await expect(page.getByLabel('Load ZIP', { exact: true })).toBeEnabled();
});
