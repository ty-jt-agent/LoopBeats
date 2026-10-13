import { expect, type Locator, type Page } from '@playwright/test';

export type FxScopeName = 'Input' | 'Track 1' | 'Track 2' | 'Master';

const scopeValues: Record<FxScopeName, string> = {
  Input: '0',
  'Track 1': '1',
  'Track 2': '2',
  Master: '3',
};

export async function openFxEditor(page: Page, scope: FxScopeName) {
  const name = `Open ${scope} effects`;
  if (scope === 'Track 1' || scope === 'Track 2') {
    const track = page.locator('.track-strip').nth(scope === 'Track 1' ? 0 : 1);
    if (await track.count()) {
      const details = track.locator('.track-details');
      const launcher = details.getByRole('button', { name });
      if (!(await launcher.isVisible()))
        await details.locator('summary').first().click();
      await launcher.click();
    } else {
      await page.getByRole('button', { name: 'Open Input effects' }).click();
    }
  } else await page.getByRole('button', { name }).click();
  const editor = page.locator('#fx-editor');
  await editor.getByLabel('Effect scope').selectOption(scopeValues[scope]);
  await expect(editor.getByRole('heading', { level: 2 })).toHaveText(
    `${scope} effects`,
  );
  return editor;
}

export async function selectFxScope(editor: Locator, scope: FxScopeName) {
  await editor.getByLabel('Effect scope').selectOption(scopeValues[scope]);
  await expect(editor.getByRole('heading', { level: 2 })).toHaveText(
    `${scope} effects`,
  );
  return editor;
}
