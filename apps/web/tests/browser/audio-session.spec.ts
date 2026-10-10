import { expect, test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

test('starts actual WASM processing and explicitly controls monitoring', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Enable monitoring' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable monitoring' }).click();
  await expect(page.getByText('Monitoring on', { exact: true })).toBeVisible();
  await expect(page.getByTestId('input-level')).not.toHaveText('0.000');
  await expect(page.getByTestId('output-level')).not.toHaveText('0.000');
  await page.getByRole('button', { name: 'Disable monitoring' }).click();
  await expect(page.getByTestId('output-level')).toHaveText('0.000');
  await page.getByRole('button', { name: 'Stop audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio stopped');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
});

test('shows recovery guidance when WASM is missing and retries successfully', async ({
  page,
}) => {
  await page.route('**/audio/loop-engine.wasm', (route) =>
    route.fulfill({ status: 404, body: 'missing' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(page.getByRole('alert')).toContainText('rebuild audio assets');
  await expect(
    page.getByRole('button', { name: 'Enable monitoring' }),
  ).toBeDisabled();
  await page.unroute('**/audio/loop-engine.wasm');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await expect(page.getByText('Monitoring off', { exact: true })).toBeVisible();
});

test('permission denial is actionable and can be retried', async ({ page }) => {
  // Reject at the browser device boundary; successful retry crosses real WASM/worklet.
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    let denied = false;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!denied) {
        denied = true;
        return Promise.reject(
          new DOMException('Denied by browser', 'NotAllowedError'),
        );
      }
      return getUserMedia(constraints);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(page.getByRole('alert')).toContainText('browser site settings');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
});

test('cancels pending permission and releases a late microphone result', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      Object.assign(window, { lateInput: stream });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return stream;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await page.waitForFunction(() =>
    Boolean((window as Window & { lateInput?: MediaStream }).lateInput),
  );
  await page.getByRole('button', { name: 'Cancel audio startup' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio stopped');
  await page.waitForFunction(() => {
    const stream = (window as Window & { lateInput?: MediaStream }).lateInput;
    return stream?.getTracks().every((track) => track.readyState === 'ended');
  });
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio stopped');
});

test('canceled failure cleanup cannot overwrite a newer ready session', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = AudioContext.prototype.close;
    let first = true;
    AudioContext.prototype.close = async function () {
      const result = original.call(this);
      if (first) {
        first = false;
        Object.assign(window, { failureClosing: true });
        await result;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else await result;
    };
  });
  await page.route('**/audio/loop-engine.wasm', (route) =>
    route.fulfill({ status: 404, body: 'missing' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio' }).click();
  await page.waitForFunction(() =>
    Boolean((window as Window & { failureClosing?: boolean }).failureClosing),
  );
  await page.getByRole('button', { name: 'Cancel audio startup' }).click();
  await page.unroute('**/audio/loop-engine.wasm');
  await page.evaluate(() => {
    Object.assign(window, { staleFailure: false });
    new MutationObserver(() => {
      if (
        document.querySelector('[role=status]')?.textContent ===
        'Audio could not start'
      )
        Object.assign(window, { staleFailure: true });
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.getByRole('button', { name: 'Start audio' }).click();
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  await page.waitForTimeout(1200);
  expect(
    await page.evaluate(
      () => (window as Window & { staleFailure?: boolean }).staleFailure,
    ),
  ).toBe(false);
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
});
