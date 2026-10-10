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

test('CLEAR confirmation keeps audio running, cancel retains it, and reset removes the shared cycle', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Track 1 details', { exact: true }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const track = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(24000);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  const length = await track.getByTestId('loop-length').textContent();
  await track.getByRole('button', { name: 'CLEAR', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear Track 1?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  const position = Number(
    await page.getByTestId('transport-position').textContent(),
  );
  await expect
    .poll(async () =>
      Number(await page.getByTestId('transport-position').textContent()),
    )
    .toBeGreaterThan(position);
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    track.getByRole('button', { name: 'CLEAR', exact: true }),
  ).toBeFocused();
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await track.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(
    track.getByRole('button', { name: 'CLEAR', exact: true }),
  ).toBeFocused();
  await track.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm' })
    .click();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await expect(
    track.locator('summary').filter({ hasText: /^Track 1 details$/ }),
  ).toBeFocused();
  await expect(page.getByTestId('cycle-length')).toHaveText(length!);
  await page.getByRole('button', { name: 'Enable monitoring' }).click();
  await page
    .getByRole('button', { name: 'Reset session', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Reset session?' })
    .getByRole('button', { name: 'Confirm' })
    .click();
  await expect(page.getByTestId('cycle-length')).toHaveText('0');
  await expect(page.getByTestId('transport-state')).toHaveText('Stopped');
  await expect(
    page.getByRole('button', { name: 'Enable monitoring' }),
  ).toBeVisible();
});

test('confirmation can be disabled and reenabled, and cleared One-shot can record again', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Track 1 details', { exact: true }).click();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await page
    .getByRole('combobox', { name: 'Track 1 playback mode' })
    .selectOption('OneShot');
  const track = page.getByRole('region', {
    name: 'Track 1 · One-shot',
    exact: true,
  });
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(24000);
  await track.getByRole('button', { name: 'Track STOP' }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await page
    .getByRole('checkbox', { name: 'Confirm before clearing' })
    .uncheck();
  await track.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await expect(track.getByRole('button', { name: /REC\/PLAY/ })).toBeEnabled();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
  await page.getByRole('checkbox', { name: 'Confirm before clearing' }).check();
  await track.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm' })
    .click();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
});

test('actual worklet CLEAR keeps other audio and cycle while reset silences and removes both', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Track 1 details', { exact: true }).click();
  const result = await page.evaluate(async () => {
    const rate = 48000,
      context = new OfflineAudioContext(2, 1024, rate);
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
    const input = context.createBuffer(1, 1024, rate);
    input.getChannelData(0).fill(0.25, 0, 256);
    input.getChannelData(0).fill(0.5, 256, 512);
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(node).connect(context.destination);
    source.start();
    await command({ type: 'record', trackId: 0 });
    const stops = [256, 512, 768].map((frame) => context.suspend(frame / rate));
    const rendered = context.startRendering();
    await stops[0];
    await command({ type: 'record', trackId: 0 });
    await command({ type: 'record', trackId: 1 });
    await context.resume();
    await stops[1];
    const cleared = await command({ type: 'clear', trackId: 0 });
    await context.resume();
    await stops[2];
    const reset = await command({ type: 'reset' });
    await context.resume();
    const audio = await rendered;
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      cleared,
      reset,
      otherAudio: left.slice(512, 768).every((x) => x === 0.5),
      resetSilent: left.slice(768).every((x) => x === 0),
      stereoMatches: left.every((x, i) => x === right[i]),
    };
  });
  expect(result.cleared.transport.cycleLengthSamples).toBe(256);
  expect(result.cleared.tracks[0].state).toBe('Empty');
  expect(result.cleared.tracks[1].state).toBe('Playing');
  expect(result.reset.transport).toEqual({
    running: false,
    positionSamples: 0,
    cycleLengthSamples: 0,
  });
  expect(result.reset.tracks.every((track) => track.state === 'Empty')).toBe(
    true,
  );
  expect(result.otherAudio).toBe(true);
  expect(result.resetSilent).toBe(true);
  expect(result.stereoMatches).toBe(true);
});
