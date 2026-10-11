import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('records and plays a first Loop through the real worklet with monitoring off', async ({
  page,
}) => {
  await page.goto('/');
  const track = page.getByRole('region', {
    name: 'Track 1 · Loop',
    exact: true,
  });
  const rec = track.getByRole('button', { name: /REC\/PLAY/ });
  await expect(rec).toBeDisabled();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await rec.click();
  await expect(track.getByTestId('track-state')).toHaveText('Recording');
  await expect(track.getByTestId('loop-length')).not.toHaveText('0');
  await page.waitForTimeout(500);
  await rec.click();
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await expect(rec).toBeEnabled();
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  await expect(page.getByTestId('output-level')).not.toHaveText('0.000');
  const length = await track.getByTestId('loop-length').textContent();
  const progress = track.getByRole('progressbar', { name: 'Loop progress' });
  await expect(progress).toHaveAttribute('max', length!);
  const before = await progress.getAttribute('value');
  await expect.poll(() => progress.getAttribute('value')).not.toBe(before);
  // Blocking the UI does not schedule, extend or erase the loop.
  await page.evaluate(() => {
    const end = performance.now() + 400;
    while (performance.now() < end) {
      /* simulated main-thread load */
    }
  });
  await expect(track.getByTestId('loop-length')).toHaveText(length!);
  await expect(track.getByTestId('track-state')).toHaveText('Playing');
  await page.getByRole('button', { name: 'Stop audio' }).click();
  await expect(track.getByTestId('track-state')).toHaveText('Empty');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(rec).toBeEnabled();
  await expect(track.getByTestId('loop-length')).toHaveText('0');
});

test('real WASM/worklet replays a known recording identically in both output channels', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(2, 1536, 48000);
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
    const command = () =>
      new Promise<{
        tracks: { lengthSamples: number; positionSamples: number }[];
      }>((resolve) => {
        node.port.onmessage = ({ data }) => resolve(data);
        node.port.postMessage({ type: 'record', trackId: 0 });
      });
    const buffer = context.createBuffer(1, 512, 48000);
    const input = buffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) input[i] = [0.25, -0.5, 0.75][i % 3];
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(node).connect(context.destination);
    source.start();
    await command();
    const suspended = context.suspend(512 / 48000);
    const rendered = context.startRendering();
    await suspended;
    const completed = await command();
    await context.resume();
    const audio = await rendered;
    const left = Array.from(audio.getChannelData(0));
    const right = Array.from(audio.getChannelData(1));
    return { left, right, completed };
  });
  expect(result.completed.tracks[0].lengthSamples).toBe(512);
  expect(result.completed.tracks[0].positionSamples).toBe(0);
  expect(result.left.slice(0, 512)).toEqual(Array(512).fill(0));
  const recorded = Array.from(
    { length: 512 },
    (_, i) => [0.25, -0.5, 0.75][i % 3],
  );
  expect(result.left.slice(512)).toEqual([...recorded, ...recorded]);
  expect(result.right).toEqual(result.left);
});
