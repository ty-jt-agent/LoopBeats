import { access, readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const required = [
  'AGENTS.md',
  'GLOSSARY.md',
  'docs/development-plan.md',
  'docs/agents/domain.md',
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
  'docs/adr',
  'docs/research',
  'docs/architecture',
  'apps/web/src',
  'apps/web/public',
  'apps/web/tests',
  'apps/windows/src',
  'apps/windows/src-tauri/src',
  'packages/audio-client/src/worklet',
  'packages/domain/src',
  'packages/ui/src',
  'Cargo.toml',
  'crates/loop-engine/Cargo.toml',
  'crates/loop-engine/src/lib.rs',
  'crates/loop-engine/tests',
];
await Promise.all(
  required.map((path) => access(new URL(`../${path}`, import.meta.url))),
);
const base = new URL('../.agents/skills/', import.meta.url);
const skills = (await readdir(base, { withFileTypes: true })).filter((entry) =>
  entry.isDirectory(),
);
for (const skill of skills) {
  const text = await readFile(new URL(`${skill.name}/SKILL.md`, base), 'utf8');
  assert.match(text, new RegExp(`^name: ${skill.name}$`, 'm'));
}
assert(skills.some((s) => s.name === 'setup-matt-pocock-skills'));
assert(skills.some((s) => s.name === 'to-issues'));
const original = await readFile(new URL('to-tickets/SKILL.md', base), 'utf8');
const alias = await readFile(new URL('to-issues/SKILL.md', base), 'utf8');
assert.equal(alias, original.replace('name: to-tickets', 'name: to-issues'));
const applicationContract = await readFile(
  new URL('../packages/domain/src/audio.ts', import.meta.url),
  'utf8',
);
assert.doesNotMatch(
  applicationContract,
  /from\s+['"](?:react|@tauri-apps\/|@loopbeats\/audio-client|tauri)['"]|\b(?:AudioContext|AudioWorkletNode|navigator|window|document)\b/,
  'The platform-neutral audio contract must not depend on browser or desktop-shell APIs.',
);
async function sourceFiles(path) {
  const directory = new URL(`../${path}`, import.meta.url);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(child);
      return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)
        ? [child]
        : [];
    }),
  );
  return nested.flat();
}
const sharedUiFiles = [
  ...(await sourceFiles('apps/web/src')).filter(
    (path) => path !== 'apps/web/src/main.tsx',
  ),
  ...(await sourceFiles('packages/ui/src')),
];
for (const path of sharedUiFiles) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /@tauri-apps\/|AudioContext|AudioWorkletNode|getUserMedia|navigator\.mediaDevices/,
    `${path} must stay independent of Tauri and browser audio APIs.`,
  );
}
const windowsManifest = JSON.parse(
  await readFile(
    new URL('../apps/windows/package.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(
  windowsManifest.scripts['tauri:build'],
  'tauri build --target x86_64-pc-windows-msvc',
);
console.log(
  `Scaffold valid: ${required.length} paths, ${skills.length} project skills.`,
);
