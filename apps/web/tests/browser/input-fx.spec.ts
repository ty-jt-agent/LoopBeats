import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('normal production does not expose unfinished Input FX', async ({
  page,
}) => {
  test.skip(
    process.env.VITE_INPUT_FX_PREVIEW === 'true',
    'Preview build has an explicit development gate.',
  );
  await page.goto('/?inputFxPreview=true');
  await expect(
    page.getByRole('region', { name: 'Input FX preview' }),
  ).toHaveCount(0);
});

test('gated Input preview acknowledges cutoff, bypass and removal through real audio', async ({
  page,
}) => {
  test.skip(
    process.env.VITE_INPUT_FX_PREVIEW !== 'true',
    'Requires explicitly gated preview build.',
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const preview = page.getByRole('region', { name: 'Input FX preview' });
  await expect(
    preview.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeDisabled();
  await expect(preview).toContainText(
    'ZIP and recovery do not yet preserve FX',
  );
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await preview.getByRole('slider', { name: 'Input cutoff' }).fill('500');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('500');
  await preview.getByRole('button', { name: 'Enable Input filter' }).click();
  await expect(
    preview.getByRole('button', { name: 'Bypass Input filter' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Enable monitoring' }).click();
  await expect(page.getByTestId('output-level')).not.toHaveText('0.000');
  await page
    .getByRole('button', { name: /Track 1 REC\/PLAY.*Record$/ })
    .click();
  await preview.getByRole('slider', { name: 'Input cutoff' }).fill('700');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('700');
  await page
    .getByRole('button', { name: /Track 1 REC\/PLAY.*Finish recording$/ })
    .click();
  await preview.getByRole('button', { name: 'Bypass Input filter' }).click();
  await expect(
    preview.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeEnabled();
  await preview
    .getByRole('combobox', { name: 'Input effect' })
    .selectOption('None');
  await expect(
    preview.getByRole('combobox', { name: 'Input effect' }),
  ).toHaveValue('None');
  await expect(
    preview.getByRole('combobox', { name: 'Input effect' }),
  ).toBeEnabled();
  await preview
    .getByRole('combobox', { name: 'Input effect' })
    .selectOption('LowPass');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('1000');
  await expect(
    preview.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Global STOP', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('actual WASM/worklet bakes Input once, retains dry playback and rejects invalid settings', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rate = 48000;
    const context = new OfflineAudioContext(2, 1024, rate);
    await context.audioWorklet.addModule('/audio/processor.js');
    const module = await WebAssembly.compile(
      await (await fetch('/audio/loop-engine.wasm')).arrayBuffer(),
    );
    const node = new AudioWorkletNode(context, 'loop-engine', {
      processorOptions: { module },
      outputChannelCount: [2],
    });
    let sequence = 0;
    const command = (data: object, expected = 'snapshot') =>
      new Promise<Record<string, unknown>>((resolve) => {
        node.port.onmessage = ({ data: reply }) => {
          if (reply.type === expected) resolve(reply);
        };
        node.port.postMessage(data);
      });
    const fx = (config: object) =>
      command(
        { type: 'set-input-fx', requestId: ++sequence, config },
        'input-fx-reply',
      );
    await fx({ type: 'LowPass', cutoffHz: 1000, bypassed: false });
    await command({ type: 'stop-transport' });
    await command({ type: 'monitoring', enabled: true });
    await command({ type: 'record', trackId: 0 });
    const input = context.createBuffer(1, 1024, rate);
    input.getChannelData(0)[0] = 0.5;
    input.getChannelData(0).fill(0.125, 512, 768);
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(node).connect(context.destination);
    source.start();
    const stops = [256, 512, 768].map((frame) => context.suspend(frame / rate));
    const rendering = context.startRendering();
    await stops[0];
    const rejected = await fx({
      type: 'LowPass',
      cutoffHz: -1,
      bypassed: true,
    });
    await command({ type: 'record', trackId: 0 });
    await fx({ type: 'None' });
    await command({ type: 'stop-transport' });
    await command({ type: 'monitoring', enabled: false });
    await command({ type: 'play', trackId: 0 });
    await context.resume();
    await stops[1];
    await command({ type: 'record', trackId: 0 });
    await context.resume();
    await stops[2];
    await command({ type: 'record', trackId: 0 });
    await context.resume();
    const rendered = await rendering;
    const snapshot = await command({ type: 'snapshot' });
    const left = rendered.getChannelData(0),
      right = rendered.getChannelData(1);
    return {
      rejected,
      snapshot,
      impulse: [...left.slice(0, 4)],
      playbackRetained: left
        .slice(0, 256)
        .every((sample, i) => sample === left[256 + i]),
      overdubOnce: left
        .slice(512, 768)
        .every((sample, i) => sample === Math.fround(left[i] + 0.125)),
      overdubRetained: left
        .slice(512, 768)
        .every((sample, i) => sample === left[768 + i]),
      channelsEqual: left.every((sample, i) => sample === right[i]),
    };
  });
  for (const [index, expected] of [
    0.00195806333027369, 0.00747067946653054, 0.01389273310983166,
    0.01901187277242247,
  ].entries())
    expect(result.impulse[index]).toBeCloseTo(expected, 7);
  expect(result.rejected.error).toContain('Invalid Input FX');
  expect(result.playbackRetained).toBe(true);
  expect(result.overdubOnce).toBe(true);
  expect(result.overdubRetained).toBe(true);
  expect(result.channelsEqual).toBe(true);
  expect(result.snapshot).toMatchObject({
    fx: [
      { config: { type: 'None' } },
      { config: { type: 'LowPass', bypassed: true } },
      { config: { type: 'LowPass', bypassed: true } },
      { config: { type: 'LowPass', bypassed: true } },
    ],
    transport: { positionSamples: 768 },
  });
});

test('preview shows rejected commands and coalesces rapid cutoff edits', async ({
  page,
}) => {
  test.skip(
    process.env.VITE_INPUT_FX_PREVIEW !== 'true',
    'Requires explicitly gated preview build.',
  );
  await page.addInitScript(() => {
    const probe = window as unknown as Window & {
      fxSent: number;
      invalidNext: boolean;
    };
    probe.fxSent = 0;
    probe.invalidNext = true;
    const RealNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends RealNode {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args);
        const send = this.port.postMessage.bind(this.port);
        this.port.postMessage = (
          data,
          options: Transferable[] | StructuredSerializeOptions = [],
        ) => {
          if (data.type === 'set-input-fx') {
            probe.fxSent++;
            if (probe.invalidNext) {
              probe.invalidNext = false;
              data = { ...data, config: { ...data.config, cutoffHz: -1 } };
            }
            setTimeout(
              () =>
                send(
                  data,
                  Array.isArray(options) ? options : (options.transfer ?? []),
                ),
              50,
            );
          } else
            send(
              data,
              Array.isArray(options) ? options : (options.transfer ?? []),
            );
        };
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const preview = page.getByRole('region', { name: 'Input FX preview' });
  await preview.getByRole('slider', { name: 'Input cutoff' }).fill('500');
  await expect(preview.getByRole('alert')).toContainText('Invalid Input FX');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('1000');
  await page.evaluate(() => {
    (window as unknown as Window & { fxSent: number }).fxSent = 0;
    const slider = document.querySelector<HTMLInputElement>(
      'input[aria-label="Input cutoff"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    for (let value = 501; value <= 550; value++) {
      setValue.call(slider, String(value));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('550');
  await expect(preview.getByRole('alert')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as Window & { fxSent: number }).fxSent,
    ),
  ).toBeLessThanOrEqual(2);
});

test('preview retains FX through interruption and same-host recovery, then discards it on Stop audio', async ({
  page,
}) => {
  test.skip(
    process.env.VITE_INPUT_FX_PREVIEW !== 'true',
    'Requires explicitly gated preview build.',
  );
  await page.addInitScript(() => {
    const RealContext = AudioContext;
    window.AudioContext = class extends RealContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        (window as unknown as { fxContext: AudioContext }).fxContext = this;
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const preview = page.getByRole('region', { name: 'Input FX preview' });
  await preview.getByRole('slider', { name: 'Input cutoff' }).fill('500');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('500');
  await preview.getByRole('button', { name: 'Enable Input filter' }).click();
  await expect(
    preview.getByRole('button', { name: 'Bypass Input filter' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Enable monitoring' }).click();
  await page.evaluate(() =>
    (window as unknown as { fxContext: AudioContext }).fxContext.suspend(),
  );
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio interrupted');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Reinitialize audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('500');
  await expect(
    preview.getByRole('button', { name: 'Bypass Input filter' }),
  ).toBeEnabled();
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Stop audio/ }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio stopped');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('1000');
  await expect(
    preview.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeEnabled();
});

type SwitchProbe = {
  missing: boolean;
  delay: boolean;
  resets: number;
  fxSnapshots: {
    config: { type: string; cutoffHz?: number };
    transitioning: boolean;
  }[];
  node?: AudioWorkletNode;
  resolve?: () => void;
};

test('input switching resets accepted ramps only on success and preserves FX on failed or abandoned switches', async ({
  page,
}) => {
  test.skip(
    process.env.VITE_INPUT_FX_PREVIEW !== 'true',
    'Requires explicitly gated preview build.',
  );
  await page.addInitScript(() => {
    const probe: SwitchProbe = {
      missing: true,
      delay: false,
      resets: 0,
      fxSnapshots: [],
    };
    (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch = probe;
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    let current: MediaStream;
    media.enumerateDevices = async () =>
      ['default', 'usb'].map((id) => ({
        deviceId: id,
        groupId: 'fixture',
        kind: 'audioinput' as const,
        label: id,
        toJSON() {
          return this;
        },
      }));
    media.getUserMedia = async (constraints) => {
      const audio = constraints?.audio;
      const device = typeof audio === 'object' ? audio.deviceId : undefined;
      const id =
        typeof device === 'object' && 'exact' in device
          ? String(device.exact)
          : 'default';
      if (id === 'usb' && probe.missing)
        throw new DOMException('USB unavailable', 'NotFoundError');
      const stream = current
        ? current.clone()
        : await original({ audio: true });
      for (const track of stream.getAudioTracks()) {
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: id });
      }
      if (probe.delay)
        await new Promise<void>((resolve) => {
          probe.resolve = resolve;
        });
      current = stream;
      return stream;
    };
    const RealNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends RealNode {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args);
        probe.node = this;
        const send = this.port.postMessage.bind(this.port);
        this.port.postMessage = (
          data,
          options: Transferable[] | StructuredSerializeOptions = [],
        ) => {
          if (data.type === 'stop-transport') probe.resets++;
          send(
            data,
            Array.isArray(options) ? options : (options.transfer ?? []),
          );
        };
        this.port.addEventListener('message', ({ data }) => {
          if (data.type === 'snapshot' && data.fx)
            probe.fxSnapshots.push(data.fx[0]);
        });
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const preview = page.getByRole('region', { name: 'Input FX preview' });
  await preview.getByRole('slider', { name: 'Input cutoff' }).fill('500');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('500');
  await preview.getByRole('button', { name: 'Enable Input filter' }).click();
  await expect(
    preview.getByRole('button', { name: 'Bypass Input filter' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Enable monitoring' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Input device' })
    .selectOption('usb');
  await expect(page.getByRole('alert')).toContainText(
    'No audio input was found',
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch.resets,
    ),
  ).toBe(0);
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('500');
  await expect(page.getByTestId('output-level')).not.toHaveText('0.000');
  await page.evaluate(() => {
    const probe = (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch;
    probe.missing = false;
    probe.fxSnapshots = [];
    // Issue the accepted FX edit and replacement in one event turn; the real
    // worklet acknowledges the ramp before the successful processing-side STOP.
    const slider = document.querySelector<HTMLInputElement>(
      'input[aria-label="Input cutoff"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(slider, '0');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Input device"]',
    )!;
    select.value = 'usb';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(
    page.getByRole('combobox', { name: 'Input device' }),
  ).toHaveValue('usb');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('0');
  await expect(
    preview.getByRole('button', { name: 'Bypass Input filter' }),
  ).toBeEnabled();
  const success = await page.evaluate(
    () => (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch,
  );
  expect(success.resets).toBe(1);
  expect(
    success.fxSnapshots.some(
      (slot) => slot.config.cutoffHz === 20 && slot.transitioning,
    ),
  ).toBe(true);
  expect(
    success.fxSnapshots.some(
      (slot) => slot.config.cutoffHz === 20 && !slot.transitioning,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch.delay = true;
  });
  await page
    .getByRole('combobox', { name: 'Input device' })
    .selectOption('default');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch.resolve,
        ),
      ),
    )
    .toBe(true);
  // A real processing command races device acquisition. Existing selection
  // guards abandon replacement, while capture and old-source history continue.
  await page.evaluate(() =>
    (
      window as unknown as { fxSwitch: SwitchProbe }
    ).fxSwitch.node!.port.postMessage({ type: 'record', trackId: 0 }),
  );
  await expect
    .poll(async () =>
      Number(await page.getByTestId('captured-samples').first().textContent()),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch.resolve!(),
  );
  await expect(
    page.getByRole('combobox', { name: 'Input device' }),
  ).toHaveValue('usb');
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toBeEnabled();
  await expect(
    preview.getByRole('slider', { name: 'Input cutoff' }),
  ).toHaveValue('0');
  expect(
    await page.evaluate(
      () => (window as unknown as { fxSwitch: SwitchProbe }).fxSwitch.resets,
    ),
  ).toBe(1);
});
