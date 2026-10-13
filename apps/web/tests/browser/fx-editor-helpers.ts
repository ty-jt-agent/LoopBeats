import { expect, type Locator, type Page } from '@playwright/test';

export type FxScopeName = 'Input' | 'Track 1' | 'Track 2' | 'Master';

const scopeValues: Record<FxScopeName, string> = {
  Input: '0',
  'Track 1': '1',
  'Track 2': '2',
  Master: '3',
};

export async function openFxEditor(page: Page, scope: FxScopeName) {
  await page
    .locator('.fx-scope-launchers')
    .getByRole('button', { name: `Open ${scope} effects` })
    .click();
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
