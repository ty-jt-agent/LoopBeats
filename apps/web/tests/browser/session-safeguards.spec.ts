import { expect, test } from '@playwright/test';
import {
  showPresentation,
  trackFixture,
  visualViewports,
} from './presentation-fixtures';

test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

for (const viewport of visualViewports) {
  for (const scene of [
    'idle',
    'ready',
    'error',
    'interrupted',
    'settings',
    'diagnostics',
    'clear-dialog',
    'reset-dialog',
  ] as const) {
    test(`${viewport.name} session safeguards presentation: ${scene}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const status = ['idle', 'error', 'interrupted'].includes(scene)
        ? (scene as 'idle' | 'error' | 'interrupted')
        : 'ready';
      await showPresentation(
        page,
        [trackFixture('Stopped'), trackFixture('Empty')],
        status,
      );
      if (scene === 'settings' || scene === 'reset-dialog') {
        const settings = page.getByRole('button', {
          name: 'Settings',
          exact: true,
        });
        await settings.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('tab', { name: 'Preferences' }).click();
        await expect(
          page.getByRole('checkbox', { name: 'Confirm before clearing' }),
        ).toBeVisible();
        await expect(
          page.getByText('Sample rate', { exact: true }),
        ).not.toBeVisible();
        if (scene === 'reset-dialog') {
          await page.getByRole('tab', { name: 'Session', exact: true }).click();
          await page
            .getByRole('button', { name: 'Reset session', exact: true })
            .click();
        }
      }
      if (scene === 'clear-dialog') {
        await page.getByText('Track 1 details', { exact: true }).click();
        await page.getByRole('button', { name: 'CLEAR', exact: true }).click();
      }
      if (scene === 'diagnostics') {
        await page
          .locator('summary')
          .filter({ hasText: /^Diagnostics$/ })
          .click();
        await expect(
          page.getByText('Sample rate', { exact: true }),
        ).toBeVisible();
      }
      if (scene.endsWith('dialog')) {
        await expect(
          page.getByRole('dialog', {
            name:
              scene === 'reset-dialog' ? 'Reset session?' : 'Clear Track 1?',
          }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Cancel', exact: true }),
        ).toBeFocused();
        const box = (await page
          .getByRole('dialog', {
            name:
              scene === 'reset-dialog' ? 'Reset session?' : 'Clear Track 1?',
          })
          .boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      }
      if (scene === 'interrupted') {
        await expect(
          page.getByRole('button', { name: 'Reinitialize audio' }),
        ).toBeEnabled();
        await expect(
          page.getByRole('button', { name: /Track 1 REC\/PLAY/ }),
        ).toBeDisabled();
      }
      if (scene === 'error') {
        await expect(page.getByRole('alert')).toContainText(
          'Allow microphone access',
        );
        await expect(
          page.getByRole('button', { name: 'Start audio', exact: true }),
        ).toBeEnabled();
      }
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
      ).toBe(false);
      const path = testInfo.outputPath(`${viewport.name}-${scene}.png`);
      await page.screenshot({
        path,
        fullPage:
          !scene.endsWith('dialog') &&
          !(scene === 'settings' && viewport.width < 1024),
        animations: 'disabled',
      });
      await testInfo.attach(`${viewport.name}-${scene}`, {
        path,
        contentType: 'image/png',
      });
    });
  }
}
