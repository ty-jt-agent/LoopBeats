// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('session format has no platform or application infrastructure dependency', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  expect(Object.keys(manifest.dependencies ?? {})).toEqual([
    '@loopbeats/domain',
  ]);

  const sourceDir = new URL('src/', root);
  const files = await readdir(sourceDir);
  const source = await Promise.all(
    files
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => readFile(new URL(file, sourceDir), 'utf8')),
  );
  const forbidden = [
    /from\s+['"]react(?:\/|['"])/,
    /from\s+['"](?:node:)?(?:fs|path|os)(?:\/|['"])/,
    /AudioContext|AudioWorklet|MessageChannel|indexedDB|Tauri|Web Locks/i,
  ];
  for (const pattern of forbidden)
    expect(source.join('\n')).not.toMatch(pattern);
});
