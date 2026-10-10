import { expect, test } from '@playwright/test';
import type { AudioSnapshot, TrackId } from '@loopbeats/domain';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('second track controls enforce capture ownership and restart only the selected Loop', async ({
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
  const rec1 = first.getByRole('button', { name: /REC\/PLAY/ });
  const rec2 = second.getByRole('button', { name: /REC\/PLAY/ });
  await expect(rec2).toBeDisabled();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(rec2).toBeEnabled();
  await rec1.click();
  await expect(first.getByTestId('track-state')).toHaveText('Recording');
  await expect(rec2).toBeDisabled();
  // A sufficiently long cycle gives UI interaction time without controlling engine completion.
  await expect
    .poll(async () =>
      Number(await first.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(96000);
  await rec1.click();
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  const length = await first.getByTestId('loop-length').textContent();
  await rec2.click();
  await expect(second.getByTestId('track-state')).toHaveText('Recording');
  await expect(rec2).toBeEnabled();
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  await expect(second.getByTestId('loop-length')).toHaveText(length!);
  await expect(second.getByTestId('track-state')).toHaveText('Playing'); // Automatic full-cycle completion.
  await expect(second.getByTestId('captured-samples')).toHaveText(length!);
  await second.getByRole('button', { name: 'Track STOP', exact: true }).click();
  await expect(second.getByTestId('track-state')).toHaveText('Stopped');
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  await second.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(second.getByTestId('track-state')).toHaveText('Playing');
  await page.getByRole('button', { name: 'Global STOP' }).click();
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  await expect(second.getByTestId('track-state')).toHaveText('Stopped');
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await expect(rec2).toHaveAccessibleName('Track 2 REC/PLAY — Play');
  await expect(rec2).toBeEnabled();
  await second.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(second.getByTestId('track-state')).toHaveText('Playing');
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  await expect(page.getByTestId('output-level')).not.toHaveText('0.000');
});

test('actual worklet keeps a one-second phrase at seconds two to three of a four-second cycle', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // Whole seconds align with 128-frame offline suspension boundaries.
    const rate = 8192;
    const context = new OfflineAudioContext(2, 90112, rate);
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
    const command = (type: string, trackId: TrackId = 0) =>
      new Promise<AudioSnapshot>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage({ type, trackId });
      });
    const source = context.createConstantSource();
    source.offset.setValueAtTime(0.125, 0);
    source.offset.setValueAtTime(0, 4);
    source.offset.setValueAtTime(0.25, 6);
    source.offset.setValueAtTime(0, 7);
    source.connect(node).connect(context.destination);
    source.start();
    await command('record', 0);
    const stops = [4, 6, 7].map((time) => context.suspend(time));
    const rendered = context.startRendering();
    await stops[0];
    const established = await command('record', 0);
    await context.resume();
    await stops[1];
    const capturing = await command('record', 1);
    await context.resume();
    await stops[2];
    const completed = await command('record', 1);
    await context.resume();
    const audio = await rendered;
    const after = await command('snapshot');
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      established,
      capturing,
      completed,
      after,
      initialSilent: left.slice(0, 32768).every((sample) => sample === 0),
      firstOnly: left.slice(32768, 81920).every((sample) => sample === 0.125),
      phraseInPhase: left.slice(81920).every((sample) => sample === 0.375),
      stereoMatches: left.every((sample, i) => sample === right[i]),
    };
  });
  expect(result.established.transport.cycleLengthSamples).toBe(32768);
  expect(result.capturing.transport.positionSamples).toBe(16384);
  expect(result.capturing.tracks[0].state).toBe('Playing');
  expect(result.capturing.tracks[0].canRecord).toBe(false);
  expect(result.capturing.tracks[1].state).toBe('Recording');
  expect(result.completed.tracks[1].capturedSamples).toBe(8192);
  expect(result.completed.tracks[1].lengthSamples).toBe(32768);
  expect(result.completed.tracks[1].state).toBe('Playing');
  expect(result.completed.transport.positionSamples).toBe(24576);
  expect(result.after.tracks.map((track) => track.positionSamples)).toEqual([
    24576, 24576,
  ]);
  expect(result.initialSilent).toBe(true);
  expect(result.firstOnly).toBe(true);
  expect(result.phraseInPhase).toBe(true);
  expect(result.stereoMatches).toBe(true);
});
