import { expect, test } from '@playwright/test';
import type { AudioSnapshot, AudioCommand } from '@loopbeats/domain';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('One-shot controls retrigger, stop globally without a Loop transport, and reject rerecording', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const mode = page.getByRole('combobox', { name: 'Track 1 playback mode' });
  await mode.selectOption('OneShot');
  const track = page.getByRole('region', {
    name: 'Track 1 · One-shot',
    exact: true,
  });
  const primaryAction = track.getByRole('button', { name: /REC\/PLAY/ });
  await primaryAction.click();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
  await expect(mode).toBeDisabled();
  await expect(
    page
      .getByRole('region', { name: 'Track 2 · Loop', exact: true })
      .getByRole('button', { name: /REC\/PLAY/ }),
  ).toBeDisabled();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(96000);
  await primaryAction.click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await expect(primaryAction).toBeEnabled();
  await expect(primaryAction).toHaveAccessibleName(
    'Track 1 REC/PLAY — Retrigger',
  );
  await expect(page.getByTestId('cycle-length')).toHaveText('0');
  await expect(page.getByTestId('transport-state')).toHaveText('Stopped');
  await primaryAction.click(); // Retrigger even while Playing.
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await page.getByRole('button', { name: 'Global STOP' }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(primaryAction).toHaveAccessibleName('Track 1 REC/PLAY — Play');
  const length = await track.getByTestId('loop-length').textContent();
  await expect(primaryAction).toBeEnabled();
  await expect(mode).toBeEnabled(); // Completed audio can convert while stopped.
  await primaryAction.click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
});

test('production worklet finishes a full 60-second One-shot and outputs it once exactly', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(2, 960128, 8000);
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
    const command = (message: AudioCommand) =>
      new Promise<AudioSnapshot & { failed: boolean }>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage(message);
      });
    const source = context.createConstantSource();
    source.offset.value = 0.25;
    source.connect(node).connect(context.destination);
    source.start();
    await command({ type: 'set-mode', trackId: 0, mode: 'OneShot' });
    await command({ type: 'record', trackId: 0 });
    const audio = await context.startRendering();
    const after = await command({ type: 'snapshot' });
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      after,
      captureSilent: left.slice(0, 480000).every((value) => value === 0),
      playsOnce: left.slice(480000, 960000).every((value) => value === 0.25),
      endedSilent: left.slice(960000).every((value) => value === 0),
      stereoMatches: left.every((value, i) => value === right[i]),
    };
  });
  expect(result.after.failed).toBe(false);
  expect(result.after.tracks[0]).toMatchObject({
    mode: 'OneShot',
    state: 'Stopped',
    lengthSamples: 480000,
    positionSamples: 480000,
    canRecord: false,
    canPlay: true,
  });
  expect(result.after.transport).toEqual({
    running: false,
    cycleLengthSamples: 0,
    positionSamples: 0,
  });
  expect(result.captureSilent).toBe(true);
  expect(result.playsOnce).toBe(true);
  expect(result.endedSilent).toBe(true);
  expect(result.stereoMatches).toBe(true);
});

test('actual One-shot capture exceeds the Loop cycle and plays from zero while Loop phase continues', async ({
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
    const command = (message: AudioCommand) =>
      new Promise<AudioSnapshot & { failed: boolean }>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage(message);
      });
    const input = context.createBuffer(1, 3328, rate);
    input.getChannelData(0).fill(0.125, 0, 512);
    input.getChannelData(0).fill(0.25, 768, 1792);
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(node).connect(context.destination);
    source.start();
    await command({ type: 'set-mode', trackId: 1, mode: 'OneShot' });
    await command({ type: 'record', trackId: 0 });
    const stops = [512, 768, 1792].map((frame) =>
      context.suspend(frame / rate),
    );
    const rendered = context.startRendering();
    await stops[0];
    await command({ type: 'record', trackId: 0 });
    await context.resume();
    await stops[1];
    await command({ type: 'record', trackId: 1 });
    await context.resume();
    await stops[2];
    const beforeFinish = await command({ type: 'snapshot' });
    const completed = await command({ type: 'record', trackId: 1 });
    await context.resume();
    const audio = await rendered;
    const after = await command({ type: 'snapshot' });
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      beforeFinish,
      completed,
      after,
      loopOnlyBefore: left.slice(512, 1792).every((value) => value === 0.125),
      combinedOnce: left.slice(1792, 2816).every((value) => value === 0.375),
      loopOnlyAfter: left.slice(2816).every((value) => value === 0.125),
      stereoMatches: left.every((value, i) => value === right[i]),
    };
  });
  expect(result.beforeFinish.tracks[1].state).toBe('Recording');
  expect(result.completed.tracks[1]).toMatchObject({
    state: 'Playing',
    lengthSamples: 1024,
    positionSamples: 0,
  });
  expect(result.after.failed).toBe(false);
  expect(result.after.transport).toEqual({
    running: true,
    cycleLengthSamples: 512,
    positionSamples: 2816,
  });
  expect(result.after.tracks[0]).toMatchObject({
    state: 'Playing',
    positionSamples: 256,
  });
  expect(result.after.tracks[1]).toMatchObject({
    state: 'Stopped',
    positionSamples: 1024,
  });
  expect(result.loopOnlyBefore).toBe(true);
  expect(result.combinedOnce).toBe(true);
  expect(result.loopOnlyAfter).toBe(true);
  expect(result.stereoMatches).toBe(true);
});
