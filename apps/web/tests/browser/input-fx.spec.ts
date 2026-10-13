import { expect, test } from '@playwright/test';
import {
  assembleSession,
  type ExportManifest,
} from '../../../../packages/audio-client/src/session-export';
import { parseSession } from '../../../../packages/audio-client/src/session-import';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { openFxEditor } from './fx-editor-helpers';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

async function fxArchive() {
  const manifest: ExportManifest = {
    format: 'LoopBeatsSession',
    version: 2,
    sampleRate: 48000,
    cycleLengthSamples: 4,
    masterGain: 0.75,
    inputFx: { type: 'LowPass', cutoffHz: 15000, bypassed: false },
    masterFx: { type: 'None' },
    tracks: [0, 1].map((id) => ({
      id,
      mode: 'Loop',
      gain: 1,
      muted: false,
      lengthSamples: id === 0 ? 4 : 0,
      audioPath: id === 0 ? 'tracks/0.wav' : null,
      fx:
        id === 0
          ? { type: 'None' }
          : { type: 'LowPass', cutoffHz: 18000, bypassed: true },
    })),
  };
  const blob = await assembleSession(
    manifest,
    async () => new Float32Array([0.5, -1.5, 0.25, 0]),
    () => {},
    () => {},
  );
  return {
    manifest,
    file: {
      name: 'fx.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(await blob.arrayBuffer()),
    },
  };
}

test('Save/Load ZIP restores all scopes and preserves independently decoded raw WAV samples', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sampleRate: 48000 });
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await openFxEditor(page, 'Input');
  await expect(
    page.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const fixture = await fxArchive();
  await page
    .getByLabel('Load ZIP', { exact: true })
    .setInputFiles(fixture.file);
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Bypass Input filter' }),
  ).toBeEnabled();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Stopped');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save ZIP', exact: true }).click();
  const path = info.outputPath('fx.zip');
  await (await downloading).saveAs(path);
  const independent = JSON.parse(
    execFileSync(
      'python',
      [
        '-c',
        "import zipfile,json,struct,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; w=z.read('tracks/0.wav'); print(json.dumps({'manifest':json.loads(z.read('session.json')),'samples':struct.unpack_from('<4f',w,56)}))",
        path,
      ],
      { encoding: 'utf8' },
    ),
  ) as { manifest: ExportManifest; samples: number[] };
  expect(independent.manifest).toEqual(fixture.manifest);
  expect(independent.samples).toEqual([0.5, -1.5, 0.25, 0]);
  await page.getByRole('button', { name: 'Bypass Input filter' }).click();
  await expect(
    page.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeEnabled();
  await page
    .getByLabel('Load ZIP', { exact: true })
    .setInputFiles(fixture.file);
  const replacement = page.getByRole('dialog', {
    name: 'Replace current session?',
  });
  await expect(replacement).toBeVisible();
  await replacement
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeEnabled();
  const buffer = await readFile(path);
  const parsed = await parseSession(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
    48000,
  );
  expect([...parsed.read(0, 0, 4)]).toEqual([0.5, -1.5, 0.25, 0]);
});

test('conversion warns about scoped cutoff caps; cancel and late FX edits preserve live session', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sampleRate: 32000 });
      }
    };
    const send = MessagePort.prototype.postMessage;
    let port: MessagePort | undefined;
    MessagePort.prototype.postMessage = function (
      message,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      // The fixture retains the public command port to send a live edit during consent.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      if (message?.type === 'set-input-fx') port = this;
      return Reflect.apply(send, this, [message, transfer ?? []]);
    };
    window.addEventListener('edit-fx-during-conversion', () =>
      port?.postMessage({
        type: 'set-input-fx',
        requestId: 999999,
        config: { type: 'LowPass', cutoffHz: 1000, bypassed: false },
      }),
    );
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await openFxEditor(page, 'Input');
  await expect(
    page.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeEnabled();
  await page.getByRole('slider', { name: 'Input cutoff' }).fill('500');
  await expect(page.getByRole('slider', { name: 'Input cutoff' })).toHaveValue(
    '500',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const fixture = await fxArchive();
  await page
    .getByLabel('Load ZIP', { exact: true })
    .setInputFiles(fixture.file);
  const conversion = page.getByRole('dialog', {
    name: 'Convert sample rate?',
  });
  await expect(conversion).toContainText(
    'Input cutoff changes from 15000 Hz to 14400 Hz',
  );
  await expect(conversion).toContainText(
    'Track 2 cutoff changes from 18000 Hz to 14400 Hz',
  );
  await conversion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await page
    .getByLabel('Load ZIP', { exact: true })
    .setInputFiles(fixture.file);
  await expect(conversion).toBeVisible();
  // A real FX command at the public worklet seam, while the modal is awaiting consent.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('edit-fx-during-conversion'));
  });
  await conversion.getByRole('button', { name: 'Convert session' }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Session changed during import' }),
  ).toBeVisible();
  await expect(
    page.locator('.track-strip').nth(0).getByTestId('track-state'),
  ).toHaveText('Empty');
  await page
    .getByLabel('Load ZIP', { exact: true })
    .setInputFiles(fixture.file);
  await expect(conversion).toBeVisible();
  await conversion.getByRole('button', { name: 'Convert session' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Session imported.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Bypass Input filter' }),
  ).toBeEnabled();
});

test('worklet exports accepted targets during removal and freezes metadata across later edits', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 256, 48000);
    await context.audioWorklet.addModule('/audio/processor.js');
    const module = await WebAssembly.compile(
      await (await fetch('/audio/loop-engine.wasm')).arrayBuffer(),
    );
    const node = new AudioWorkletNode(context, 'loop-engine', {
      processorOptions: { module },
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
    await command({ type: 'record', trackId: 0 });
    const buffer = context.createBuffer(1, 256, 48000);
    buffer.getChannelData(0).fill(0.25);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(node).connect(context.destination);
    source.start();
    await context.startRendering();
    await command({ type: 'record', trackId: 0 });
    await fx({ type: 'LowPass', cutoffHz: 1000, bypassed: false });
    const token = ++sequence;
    const frozen = await command(
      { type: 'export-begin', requestId: token },
      'export-reply',
    );
    await fx({ type: 'LowPass', cutoffHz: 2000, bypassed: true });
    const audio = await command(
      {
        type: 'export-read',
        requestId: ++sequence,
        token,
        trackId: 0,
        offset: 0,
        frames: 256,
      },
      'export-reply',
    );
    await command(
      { type: 'export-finish', requestId: ++sequence, token },
      'export-reply',
    );
    await fx({ type: 'None' });
    const removing = await command({ type: 'snapshot' });
    const removed = await command(
      { type: 'export-begin', requestId: ++sequence },
      'export-reply',
    );
    return {
      frozen,
      samples: [...(audio.samples as Float32Array)],
      removing,
      removed,
    };
  });
  expect(result.frozen).toMatchObject({
    manifest: {
      version: 2,
      inputFx: { type: 'LowPass', cutoffHz: 1000, bypassed: false },
    },
  });
  expect(result.samples).toEqual(Array(256).fill(0.25));
  expect((result.removing.fx as object[])[0]).toMatchObject({
    config: { type: 'None' },
    removing: true,
  });
  expect(result.removed).toMatchObject({
    manifest: { inputFx: { type: 'None' } },
  });
});

test('normal production exposes the persistent FX editor regardless of URL query', async ({
  page,
}) => {
  await page.goto('/?inputFxPreview=true');
  await expect(
    page.getByRole('button', { name: 'Open Input effects' }),
  ).toBeVisible();
  const editor = await openFxEditor(page, 'Input');
  await expect(editor).not.toContainText('Preview only');
  await expect(editor).not.toContainText('recovery does not yet preserve FX');
});

test('Input editor acknowledges cutoff, bypass and removal through real audio', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const preview = await openFxEditor(page, 'Input');
  await expect(
    preview.getByRole('button', { name: 'Enable Input filter' }),
  ).toBeDisabled();
  await expect(preview).toContainText('Start audio');
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

test('FX editor shows rejected commands and coalesces rapid cutoff edits', async ({
  page,
}) => {
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
  const preview = await openFxEditor(page, 'Input');
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

test('FX editor retains settings through interruption and same-host recovery, then discards them on Stop audio', async ({
  page,
}) => {
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
  const preview = await openFxEditor(page, 'Input');
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
  const preview = await openFxEditor(page, 'Input');
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
