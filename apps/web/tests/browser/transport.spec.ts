import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('track STOP retains a silent capture and global STOP resets the timeline without discarding it', async ({
  page,
}) => {
  // Silent capture is valid audio; control/retention behavior must not depend on
  // when Chromium's synthetic microphone emits its periodic tone.
  await page.addInitScript(() => {
    const original = AudioContext.prototype.createMediaStreamSource;
    AudioContext.prototype.createMediaStreamSource = function (stream) {
      const source = original.call(this, stream);
      const gate = this.createGain();
      gate.gain.value = 0;
      source.connect(gate);
      return gate as unknown as MediaStreamAudioSourceNode;
    };
  });
  await page.goto('/');
  const track = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  await expect(
    track.getByRole('button', { name: 'Track STOP', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(track.getByTestId('capture-remaining')).toHaveText('60.0 s');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
  await expect(track.getByTestId('capture-remaining')).not.toHaveText('60.0 s');
  await track.getByRole('button', { name: 'Track STOP', exact: true }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(page.getByTestId('transport-state')).toHaveText('Stopped');
  const length = await track.getByTestId('loop-length').textContent();
  expect(Number(length)).toBeGreaterThan(0);
  await expect(track.getByRole('button', { name: /REC\/PLAY/ })).toBeEnabled();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(page.getByTestId('transport-state')).toHaveText('Running');
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await expect(page.getByTestId('output-level')).toHaveText('0.000');
  await track.getByRole('button', { name: 'Track STOP', exact: true }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Stopped');
  await expect(page.getByTestId('transport-state')).toHaveText('Running');
  const position = await page.getByTestId('transport-position').textContent();
  await expect
    .poll(() => page.getByTestId('transport-position').textContent())
    .not.toBe(position);
  await expect(
    page.getByRole('button', { name: 'Global Start', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Global Start', exact: true }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await expect(page.getByTestId('track-state').nth(1)).toHaveText('Empty');
  await page.getByRole('button', { name: 'Global STOP', exact: true }).click();
  await expect(page.getByTestId('transport-state')).toHaveText('Stopped');
  await expect(page.getByTestId('transport-position')).toHaveText('0');
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await expect(page.getByTestId('output-level')).toHaveText('0.000');
  await expect(track.getByRole('button', { name: /REC\/PLAY/ })).toBeEnabled();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await expect(page.getByTestId('output-level')).toHaveText('0.000');
});

test('global STOP discards unfinished first capture and permits a new recording', async ({
  page,
}) => {
  await page.goto('/');
  const track = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('loop-length')).not.toHaveText('0');
  await page.getByRole('button', { name: 'Global STOP', exact: true }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await expect(track.getByTestId('loop-length')).toHaveText('0');
  await expect(page.getByTestId('cycle-length')).toHaveText('0');
  await expect(track.getByTestId('capture-remaining')).toHaveText('60.0 s');
  await expect(track.getByRole('button', { name: /REC\/PLAY/ })).toBeEnabled();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
});

test('clearing the last Loop keeps REC available and idle Global STOP cannot strand the session', async ({
  page,
}) => {
  await page.goto('/');
  const track = page.getByRole('region', { name: /Track 1/ });
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('loop-length')).not.toHaveText('0');
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await track.getByText('Track 1 details').click();
  await track.getByRole('button', { name: 'CLEAR', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Confirm/ })
    .click();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await expect(
    page.getByRole('button', { name: 'Global Start', exact: true }),
  ).toBeDisabled();
  await track.getByRole('button', { name: /REC\/PLAY/ }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
});

for (const mode of ['Loop', 'OneShot']) {
  test(`Global Start resumes retained Loop and ${mode} tracks together`, async ({
    page,
  }) => {
    await page.goto('/');
    const first = page.getByRole('region', { name: /Track 1/ });
    const second = page.getByRole('region', { name: /Track 2/ });
    await page.getByRole('button', { name: 'Start audio' }).click();
    await expect(
      page.getByRole('status', { name: 'Audio status' }),
    ).toContainText('Audio ready');
    await second.getByRole('combobox').selectOption(mode);
    await first.getByRole('button', { name: /REC\/PLAY/ }).click();
    await expect
      .poll(async () =>
        Number(await first.getByTestId('captured-samples').textContent()),
      )
      .toBeGreaterThan(48000);
    await first.getByRole('button', { name: /REC\/PLAY/ }).click();
    await expect(first.getByTestId('track-state')).toHaveText('Playing');
    await second.getByRole('button', { name: /REC\/PLAY/ }).click();
    await expect
      .poll(async () =>
        Number(await second.getByTestId('captured-samples').textContent()),
      )
      .toBeGreaterThan(24000);
    await second
      .getByRole('button', { name: 'Track STOP', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Global STOP', exact: true })
      .click();
    await expect(first.getByTestId('track-state')).toHaveText('Stopped');
    await expect(second.getByTestId('track-state')).toHaveText('Stopped');
    await page
      .getByRole('button', { name: 'Global Start', exact: true })
      .click();
    await expect(first.getByTestId('track-state')).toHaveText('Playing');
    await expect(second.getByTestId('track-state')).toHaveText('Playing');
    await expect(
      page.getByRole('status', { name: 'Audio status' }),
    ).toContainText('Audio ready');
    if (mode === 'OneShot') {
      await expect(second.getByTestId('track-state')).toHaveText('Stopped');
      await expect(first.getByTestId('track-state')).toHaveText('Playing');
    }
  });
}

test('production worklet completes a real 60-second sample capture automatically', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(2, 480256, 8000);
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
      new Promise<{
        failed: boolean;
        tracks: {
          state: string;
          lengthSamples: number;
          capacitySamples: number;
          positionSamples: number;
          canRecord: boolean;
        }[];
        transport: {
          running: boolean;
          positionSamples: number;
          cycleLengthSamples: number;
        };
      }>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage({ type, trackId: 0 });
      });
    const source = context.createConstantSource();
    source.offset.value = 0.25;
    source.connect(node).connect(context.destination);
    source.start();
    const before = await command('record');
    const audio = await context.startRendering();
    const after = await command('snapshot');
    const left = audio.getChannelData(0),
      right = audio.getChannelData(1);
    return {
      before,
      after,
      captureSilent: left.slice(0, 480000).every((sample) => sample === 0),
      replay: Array.from(left.slice(480000)),
      stereoMatches: left.every((sample, i) => sample === right[i]),
    };
  });
  expect(result.before.tracks[0].state).toBe('Recording');
  expect(result.before.tracks[0].capacitySamples).toBe(480000);
  expect(result.after.failed).toBe(false);
  expect(result.after.tracks[0].state).toBe('Playing');
  expect(result.after.tracks[0].lengthSamples).toBe(480000);
  expect(result.after.tracks[0].positionSamples).toBe(256);
  expect(result.after.tracks[0].canRecord).toBe(true);
  expect(result.after.transport).toEqual({
    running: true,
    positionSamples: 256,
    cycleLengthSamples: 480000,
  });
  expect(result.captureSilent).toBe(true);
  expect(result.replay).toEqual(Array(256).fill(0.25));
  expect(result.stereoMatches).toBe(true);
});
