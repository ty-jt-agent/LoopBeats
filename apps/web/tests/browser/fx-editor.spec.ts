import { expect, test } from '@playwright/test';
import { selectFxScope } from './fx-editor-helpers';

test('FX editor navigates scopes before audio and returns focus on Escape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');

  const inputLauncher = page.getByRole('button', {
    name: 'Open Input effects',
  });
  await inputLauncher.click();

  const editor = page.locator('#fx-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('heading', { level: 2 })).toHaveText(
    'Input effects',
  );
  await expect(editor).toContainText('Start audio to edit effects.');
  await expect(editor.getByLabel('Input effect')).toBeDisabled();

  const scope = editor.getByLabel('Effect scope');
  await expect(scope).toBeEnabled();
  await selectFxScope(editor, 'Track 2');
  await expect(editor.getByRole('heading', { level: 2 })).toHaveText(
    'Track 2 effects',
  );
  await expect(editor.getByLabel('Track 2 effect')).toBeDisabled();
  await selectFxScope(editor, 'Master');
  await expect(editor.getByRole('heading', { level: 2 })).toHaveText(
    'Master effects',
  );

  await scope.focus();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(inputLauncher).toBeFocused();
  await inputLauncher.click();
  await expect(editor.getByLabel('Effect scope')).toHaveValue('3');
  await expect(
    page.evaluate(() => document.documentElement.scrollWidth),
  ).resolves.toBeLessThanOrEqual(320);
});

for (const viewport of [
  { name: 'phone', width: 320, height: 844 },
  { name: 'iPad', width: 768, height: 1024 },
  { name: 'zoomed', width: 640, height: 400 },
]) {
  test(`editor controls fit ${viewport.name} with touch targets and reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const editor = page.locator('#fx-editor');
    await page.getByRole('button', { name: 'Open Input effects' }).click();
    await expect(editor).toBeVisible();
    await editor.getByLabel('Effect scope').selectOption('2');
    await expect(editor.getByRole('heading', { level: 2 })).toHaveText(
      'Track 2 effects',
    );
    const touchTargets = [
      editor.getByLabel('Effect scope'),
      editor.getByLabel('Track 2 effect'),
      editor.getByRole('button', { name: 'Enable Track 2 filter' }),
      editor.getByRole('slider', { name: 'Track 2 cutoff' }),
      editor.getByRole('button', {
        name: 'Lower Track 2 cutoff by 1/12 octave',
      }),
      editor.getByRole('button', {
        name: 'Raise Track 2 cutoff by 1/12 octave',
      }),
      editor.getByRole('button', { name: 'Close effects' }),
    ];
    for (const target of touchTargets) {
      const box = await target.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await expect
      .poll(() =>
        page.evaluate(
          () => matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
      )
      .toBe(true);
  });
}
