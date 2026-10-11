import { expect, test } from '@playwright/test';
import type { AudioCommand, AudioSnapshot } from '@loopbeats/domain';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('stopped mode controls preserve audio and active playback locks conversion', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const mode = page.getByRole('combobox', { name: 'Track 1 playback mode' });
  await mode.selectOption('OneShot');
  const track = page
    .locator('section')
    .filter({ has: page.locator('#track-heading-0') })
    .last();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(24000);
  await track.getByRole('button', { name: 'Track STOP' }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  const length = await track.getByTestId('loop-length').textContent();
  await expect(mode).toBeEnabled();
  await mode.selectOption('Loop');
  await expect(page.getByTestId('cycle-length')).toHaveText('0');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Overdubbing');
  await expect(mode).toBeDisabled();
  await expect(page.getByTestId('cycle-length')).toHaveText(length!);
  await track.getByRole('button', { name: 'Track STOP' }).click();
  await mode.selectOption('OneShot');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(mode).toBeDisabled();
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(mode).toBeEnabled();
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await mode.selectOption('Loop');
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
});

test('incompatible stopped One-shot disables Loop selection and explains the required length', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const first = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  await first.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await first.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(24000);
  await first.getByRole('button', { name: /REC\/PLAY/ }).click();
  const cycle = Number(await page.getByTestId('cycle-length').textContent());
  const mode = page.getByRole('combobox', { name: 'Track 2 playback mode' });
  await mode.selectOption('OneShot');
  const second = page.getByRole('region', {
    name: 'Track 2 · One-shot',
    exact: true,
  });
  await second.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await second.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(cycle);
  await second.getByRole('button', { name: 'Track STOP' }).click();
  await expect(mode).toBeEnabled();
  await expect(mode.locator('option[value="Loop"]')).toHaveAttribute(
    'disabled',
    '',
  );
  await expect(second).toContainText('match the shared cycle length exactly');
  await expect(second.getByRole('button', { name: /REC\/PLAY/ })).toBeEnabled();
});

test('actual worklet conversion establishes cycle on REC, preserves samples and rejects active mode changes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rate = 48000;
    const context = new OfflineAudioContext(2, 1792, rate);
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
      new Promise<AudioSnapshot>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage(message);
      });
    const input = context.createBuffer(1, 1792, rate);
    input.getChannelData(0).fill(0.25, 0, 512);
    input.getChannelData(0).fill(0.125, 512, 1024);
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(node).connect(context.destination);
    source.start();
    await command({ type: 'set-mode', trackId: 0, mode: 'OneShot' });
    await command({ type: 'record', trackId: 0 });
    const stops = [512, 1024, 1280].map((frame) =>
      context.suspend(frame / rate),
    );
    const rendering = context.startRendering();
    await stops[0];
    await command({ type: 'stop-track', trackId: 0 });
    const converted = await command({
      type: 'set-mode',
      trackId: 0,
      mode: 'Loop',
    });
    const overdub = await command({ type: 'record', trackId: 0 });
    const rejected = await command({
      type: 'set-mode',
      trackId: 0,
      mode: 'OneShot',
    });
    await context.resume();
    await stops[1];
    await command({ type: 'stop-track', trackId: 0 });
    await command({ type: 'set-mode', trackId: 0, mode: 'OneShot' });
    await context.resume();
    await stops[2];
    await command({ type: 'play', trackId: 0 });
    await context.resume();
    const audio = await rendering;
    const final = await command({ type: 'snapshot' });
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      converted,
      overdub,
      rejected,
      final,
      overdubCorrect: left.slice(512, 1024).every((x) => x === 0.375),
      stoppedSilent: left.slice(1024, 1280).every((x) => x === 0),
      shotCorrect: left.slice(1280).every((x) => x === 0.375),
      stereoMatches: left.every((x, i) => x === right[i]),
    };
  });
  expect(result.converted.transport.cycleLengthSamples).toBe(0);
  expect(result.overdub.transport).toEqual({
    running: true,
    positionSamples: 0,
    cycleLengthSamples: 512,
  });
  expect(result.overdub.tracks[0].state).toBe('Overdubbing');
  expect(result.rejected.tracks[0].mode).toBe('Loop');
  expect(result.final.tracks[0]).toMatchObject({
    mode: 'OneShot',
    state: 'Stopped',
    lengthSamples: 512,
  });
  expect(result.overdubCorrect).toBe(true);
  expect(result.stoppedSilent).toBe(true);
  expect(result.shotCorrect).toBe(true);
  expect(result.stereoMatches).toBe(true);
});
