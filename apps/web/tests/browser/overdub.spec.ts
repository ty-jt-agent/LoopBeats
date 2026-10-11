import { expect, test } from '@playwright/test';
import type { AudioSnapshot } from '@loopbeats/domain';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('REC controls immediate overdub and capture exclusion through the production bridge', async ({
  page,
}) => {
  await page.goto('/');
  const first = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  const second = page.getByRole('region', {
    name: 'Track 2 · Loop',
    exact: true,
  });
  const rec = first.getByRole('button', { name: /REC\/PLAY/ });
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await rec.click();
  await expect(first.getByTestId('captured-samples')).not.toHaveText('0');
  await rec.click();
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  const length = await first.getByTestId('loop-length').textContent();
  await rec.click();
  await expect(first.getByTestId('track-state')).toHaveText('Overdubbing');
  await expect(rec).toBeEnabled();
  await expect(
    second.getByRole('button', { name: /REC\/PLAY/ }),
  ).toBeDisabled();
  await expect(page.getByTestId('output-level')).not.toHaveText('0.000');
  await rec.click();
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  await expect(second.getByRole('button', { name: /REC\/PLAY/ })).toBeEnabled();
  await first.getByRole('button', { name: 'Track STOP', exact: true }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  await rec.click();
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  await rec.click();
  await expect(first.getByTestId('track-state')).toHaveText('Overdubbing');
  await page.getByRole('button', { name: 'Global STOP' }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  await expect(first.getByTestId('loop-length')).toHaveText(length!);
  await expect(rec).toBeEnabled();
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await first.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(page.getByTestId('output-level')).not.toHaveText('0.000');
});

test('actual WASM/worklet adds across cycles and protects only output, retaining full-volume audio', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rate = 48000;
    const context = new OfflineAudioContext(2, 3328, rate);
    const module = await WebAssembly.compile(
      await (await fetch('/audio/loop-engine.wasm')).arrayBuffer(),
    );
    await context.audioWorklet.addModule('/audio/processor.js');
    const node = new AudioWorkletNode(context, 'loop-engine', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: { module },
    });
    const command = (type: string) =>
      new Promise<AudioSnapshot & { failed: boolean }>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage({ type, trackId: 0 });
      });
    const input = context.createBuffer(1, 3328, rate);
    input.getChannelData(0).fill(0.75);
    input.getChannelData(0).fill(-0.75, 1792);
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(node).connect(context.destination);
    source.start();
    await command('record');
    const stops = [512, 768, 1792, 2816].map((frame) =>
      context.suspend(frame / rate),
    );
    const rendered = context.startRendering();
    await stops[0];
    await command('record');
    await context.resume();
    await stops[1];
    const started = await command('record');
    await context.resume();
    await stops[2];
    const finished = await command('record');
    await command('record'); // Subtract over two further cycles, no feedback reduction.
    await context.resume();
    await stops[3];
    await command('record');
    await context.resume();
    const audio = await rendered;
    const after = await command('snapshot');
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      started,
      finished,
      after,
      captureSilent: left.slice(0, 512).every((value) => value === 0),
      original: left.slice(512, 768).every((value) => value === 0.75),
      protected: left.slice(768, 2304).every((value) => value === 1),
      retained: left.slice(2304).every((value) => value === 0.75),
      stereoMatches: left.every((value, i) => value === right[i]),
    };
  });
  expect(result.started.tracks[0].state).toBe('Overdubbing');
  expect(result.finished.tracks[0].state).toBe('Playing');
  expect(result.after.failed).toBe(false);
  expect(result.after.tracks[0].lengthSamples).toBe(512);
  expect(result.after.transport.positionSamples).toBe(2816);
  expect(result.captureSilent).toBe(true);
  expect(result.original).toBe(true);
  expect(result.protected).toBe(true);
  expect(result.retained).toBe(true);
  expect(result.stereoMatches).toBe(true);
});
