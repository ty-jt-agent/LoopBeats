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

test('volume and mute controls acknowledge engine values while recording and playback continue', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const track = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  await page
    .getByRole('slider', { name: 'Master volume', exact: true })
    .fill('0.5');
  await expect(
    page.getByRole('slider', { name: 'Master volume', exact: true }),
  ).toHaveValue('0.5');
  await track
    .getByRole('slider', { name: 'Track 1 volume', exact: true })
    .fill('0.25');
  await expect(
    track.getByRole('slider', { name: 'Track 1 volume', exact: true }),
  ).toHaveValue('0.25');
  await track.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(
    track.getByRole('button', { name: 'Unmute', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect
    .poll(async () =>
      Number(await track.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThanOrEqual(24000);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await expect(page.getByTestId('output-level')).toHaveText('0.000');
  const position = Number(
    await page.getByTestId('transport-position').textContent(),
  );
  await expect
    .poll(async () =>
      Number(await page.getByTestId('transport-position').textContent()),
    )
    .toBeGreaterThan(position);
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Overdubbing');
  await track.getByRole('button', { name: 'Unmute', exact: true }).click();
  await expect(
    track.getByRole('button', { name: 'Mute', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(track.getByTestId('track-state')).toHaveText('Overdubbing');
});

test('actual WASM mixes gains mathematically and retains muted overdub at full input volume', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rate = 48000,
      context = new OfflineAudioContext(2, 1664, rate);
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
    const input = context.createBuffer(1, 1664, rate);
    input.getChannelData(0).fill(0.25, 0, 256);
    input.getChannelData(0).fill(0.5, 256, 512);
    input.getChannelData(0).fill(0.125, 1024, 1152);
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(node).connect(context.destination);
    source.start();
    await command({ type: 'record', trackId: 0 });
    const stops = [256, 512, 768, 1024, 1152, 1280].map((frame) =>
      context.suspend(frame / rate),
    );
    const rendering = context.startRendering();
    await stops[0];
    await command({ type: 'record', trackId: 0 });
    await command({ type: 'record', trackId: 1 });
    await context.resume();
    await stops[1];
    await command({ type: 'set-track-gain', trackId: 0, gain: 0.5 });
    await command({ type: 'set-track-gain', trackId: 1, gain: 0.25 });
    await command({ type: 'set-master-gain', gain: 0.5 });
    await context.resume();
    await stops[2];
    await command({ type: 'set-track-mute', trackId: 0, muted: true });
    await context.resume();
    await stops[3];
    await command({ type: 'record', trackId: 0 });
    await context.resume();
    await stops[4];
    await command({ type: 'record', trackId: 0 });
    await context.resume();
    await stops[5];
    await command({ type: 'set-track-mute', trackId: 0, muted: false });
    await command({ type: 'set-track-gain', trackId: 0, gain: 1 });
    await command({ type: 'set-track-gain', trackId: 1, gain: 0 });
    await command({ type: 'set-master-gain', gain: 1 });
    await context.resume();
    const audio = await rendering,
      after = await command({ type: 'snapshot' });
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      after,
      gainCorrect: left.slice(512, 768).every((x) => x === 0.125),
      muteCorrect: left.slice(768, 1280).every((x) => x === 0.0625),
      retainedCorrect:
        left.slice(1280, 1408).every((x) => x === 0.375) &&
        left.slice(1408, 1536).every((x) => x === 0.25) &&
        left.slice(1536).every((x) => x === 0.375),
      stereoMatches: left.every((x, i) => x === right[i]),
    };
  });
  expect(result.gainCorrect).toBe(true);
  expect(result.muteCorrect).toBe(true);
  expect(result.retainedCorrect).toBe(true);
  expect(result.stereoMatches).toBe(true);
  expect(result.after.masterGain).toBe(1);
  expect(result.after.tracks[0]).toMatchObject({
    gain: 1,
    muted: false,
    state: 'Playing',
    lengthSamples: 256,
  });
  expect(result.after.tracks[1]).toMatchObject({
    gain: 0,
    state: 'Playing',
    lengthSamples: 256,
  });
});
