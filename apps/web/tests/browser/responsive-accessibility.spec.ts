import { expect, test, type Page } from '@playwright/test';
import {
  showPresentation,
  trackFixture,
  visualViewports,
} from './presentation-fixtures';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

async function assertTargets(page: Page, width: number) {
  for (const control of await page
    .locator('button, select, input, summary')
    .all()) {
    if (!(await control.isVisible())) continue;
    await control.scrollIntoViewIfNeeded();
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

for (const viewport of [...visualViewports, { width: 640, height: 400 }]) {
  test(`controls and disclosures fit ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await showPresentation(page, [
      trackFixture('Playing'),
      trackFixture('Recording', true),
    ]);
    const overflow = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
    expect(await overflow()).toBe(false);
    const tracks = page.getByRole('region', { name: /^Track [12]/ });
    const first = (await tracks.nth(0).boundingBox())!;
    const second = (await tracks.nth(1).boundingBox())!;
    if (viewport.width >= 768) expect(first.y).toBe(second.y);
    else expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    await assertTargets(page, viewport.width);
    for (const summary of await page.locator('summary').all()) {
      if (await summary.isVisible()) await summary.click();
    }
    expect(await overflow()).toBe(false);
    await expect(page.getByText('Sample rate', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(
      page.getByRole('checkbox', { name: 'Confirm before clearing' }),
    ).toBeVisible();
    await assertTargets(page, viewport.width);
  });
}

test('keyboard operates the performance, settings and removal workflows at zoom-equivalent size', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start audio', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status', { name: 'Audio status' }),
  ).toContainText('Audio ready');
  const stopAudio = page.getByRole('button', { name: 'Stop audio' });
  await stopAudio.focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Enable monitoring' }),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: 'Disable monitoring' }),
  ).toBeVisible();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  const master = page.getByRole('slider', { name: 'Master volume' });
  await expect(master).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(master).toHaveValue('0.99');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('combobox', { name: 'Track 1 playback mode' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  const gain = page.getByRole('slider', { name: 'Track 1 volume' });
  await expect(gain).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(gain).not.toHaveValue('1');
  await page.keyboard.press('Tab');
  const first = page.getByRole('region', { name: /Track 1/ });
  const rec = first.getByRole('button', { name: /REC\/PLAY/ });
  await expect(rec).toBeFocused();
  const focus = await rec.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(focus.style).toBe('solid');
  expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('Enter');
  await expect(first.getByTestId('track-state')).toHaveText('Recording');
  await expect
    .poll(async () =>
      Number(await first.getByTestId('captured-samples').textContent()),
    )
    .toBeGreaterThan(24000);
  await page.keyboard.press('Enter');
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  const global = page.getByRole('button', { name: 'Global STOP', exact: true });
  await global.focus();
  await page.keyboard.press('Enter');
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  await expect(
    page.getByRole('button', { name: 'Global Start', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(first.getByTestId('track-state')).toHaveText('Playing');
  await rec.focus();
  await page.keyboard.press('Tab');
  await expect(
    first.getByRole('button', { name: 'Track STOP', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await expect(first.getByTestId('track-state')).toHaveText('Stopped');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(first.getByRole('button', { name: 'Unmute' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Tab');
  await expect(
    first.locator('summary').filter({ hasText: /^Track 1 details$/ }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(
    first.locator('summary').filter({ hasText: /^Track 1 diagnostics$/ }),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await expect(first.getByTestId('captured-samples')).toBeVisible();
  await page.keyboard.press('Tab');
  const clear = first.getByRole('button', { name: 'CLEAR', exact: true });
  await expect(clear).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Clear Track 1?' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await assertTargets(page, 640);
  await page.keyboard.press('Escape');
  await expect(clear).toBeFocused();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();
  await page.keyboard.press('Space');
  await page.getByRole('tab', { name: 'Preferences' }).click();
  const preference = page.getByRole('checkbox', {
    name: 'Confirm before clearing',
  });
  await preference.focus();
  await page.keyboard.press('Space');
  await expect(preference).not.toBeChecked();
  await page.keyboard.press('Space');
  await page.getByRole('tab', { name: 'Session', exact: true }).click();
  const reset = page.getByRole('button', {
    name: 'Reset session',
    exact: true,
  });
  await reset.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Reset session?' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reset).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Confirm', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(first.getByTestId('track-state')).toHaveText('Empty');
  await expect(
    page.getByRole('tab', { name: 'Session', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Close Settings' }).click();
  const diagnostics = page
    .locator('summary')
    .filter({ hasText: /^Diagnostics$/ });
  await diagnostics.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sample rate', { exact: true })).toBeVisible();
});

test('reduced motion retains textual state, mute and snapshot progress', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await showPresentation(page, [
    trackFixture('Overdubbing'),
    trackFixture('Playing', true),
  ]);
  await expect(page.getByTestId('track-state').first()).toHaveText(
    'Overdubbing',
  );
  await expect(page.getByText('Muted · position continues')).toBeVisible();
  await expect(page.getByRole('progressbar').first()).toHaveAttribute(
    'value',
    '48000',
  );
  const motion = await page.locator('*').evaluateAll((elements) =>
    elements.every((element) => {
      const style = getComputedStyle(element);
      return (
        style.animationName === 'none' && style.transitionDuration === '0s'
      );
    }),
  );
  expect(motion).toBe(true);
});

for (const state of [
  'Recording',
  'Playing',
  'Overdubbing',
  'Stopped',
] as const) {
  test(`${state} text, control borders and keyboard focus meet contrast thresholds`, async ({
    page,
  }) => {
    await showPresentation(page, [
      trackFixture(state),
      trackFixture('Playing', true),
    ]);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const primary = page.getByRole('button', { name: /Track 1 REC\/PLAY/ });
    await primary.focus();
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: 'Unmute', exact: true }).hover();
    const contrasts = await page.evaluate(() => {
      const rgb = (color: string) =>
        color
          .match(/[\d.]+/g)!
          .map(Number)
          .slice(0, 3);
      const luminance = (channels: number[]) =>
        channels
          .map((value) => {
            const s = value / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          })
          .reduce(
            (sum, value, index) =>
              sum + value * [0.2126, 0.7152, 0.0722][index],
            0,
          );
      const ratio = (first: string, second: string) => {
        const a = luminance(rgb(first));
        const b = luminance(rgb(second));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const background = (element: Element): string => {
        const color = getComputedStyle(element).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)') return color;
        return element.parentElement
          ? background(element.parentElement)
          : 'rgb(16, 18, 21)';
      };
      const visible = (element: Element) => element.getClientRects().length > 0;
      const text = Array.from(
        document.querySelectorAll(
          'h1,h2,p,label,span,strong,summary,button,select,dt,dd',
        ),
      )
        .filter(
          (element) =>
            visible(element) &&
            Array.from(element.childNodes).some(
              (node) =>
                node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            ),
        )
        .map((element) => ({
          name: element.textContent?.trim().slice(0, 60),
          ratio: ratio(getComputedStyle(element).color, background(element)),
        }));
      const boundaries = Array.from(
        document.querySelectorAll('button,select,input'),
      )
        .filter(visible)
        .filter(
          (element) => parseFloat(getComputedStyle(element).borderTopWidth) > 0,
        )
        .map((element) => ({
          name:
            element.getAttribute('aria-label') ??
            element.textContent?.trim().slice(0, 60),
          ratio: Math.min(
            ratio(
              getComputedStyle(element).borderTopColor,
              background(element),
            ),
            ratio(
              getComputedStyle(element).borderTopColor,
              background(element.parentElement!),
            ),
          ),
        }));
      const focused = document.activeElement!;
      const style = getComputedStyle(focused);
      return {
        text,
        boundaries,
        focusRatio: ratio(
          style.outlineColor,
          background(focused.parentElement!),
        ),
      };
    });
    expect(contrasts.text.length).toBeGreaterThan(10);
    for (const sample of contrasts.text)
      expect(sample.ratio, sample.name).toBeGreaterThanOrEqual(4.5);
    for (const sample of contrasts.boundaries)
      expect(sample.ratio, sample.name ?? undefined).toBeGreaterThanOrEqual(3);
    expect(contrasts.focusRatio).toBeGreaterThanOrEqual(3);
  });
}
