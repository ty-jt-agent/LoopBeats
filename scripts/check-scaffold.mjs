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
async function filesUnder(path, extensions) {
  const directory = new URL(`../${path}`, import.meta.url);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return filesUnder(child, extensions);
      return extensions.some((extension) => entry.name.endsWith(extension))
        ? [child]
        : [];
    }),
  );
  return nested.flat();
}

const packageManifest = async (path) =>
  JSON.parse(
    await readFile(new URL(`../${path}/package.json`, import.meta.url)),
  );
const [
  domainPackage,
  uiPackage,
  sessionFormatPackage,
  audioClientPackage,
  webPackage,
] = await Promise.all([
  packageManifest('packages/domain'),
  packageManifest('packages/ui'),
  packageManifest('packages/session-format'),
  packageManifest('packages/audio-client'),
  packageManifest('apps/web'),
]);
for (const [name, manifest] of [
  ['domain', domainPackage],
  ['session-format', sessionFormatPackage],
]) {
  const dependencies = Object.keys(manifest.dependencies ?? {});
  assert(
    !dependencies.some((dependency) =>
      /tauri|react|audio-client/i.test(dependency),
    ),
    `Shared ${name} package must not depend on React, audio-client, or Tauri.`,
  );
}
const uiDependencies = Object.keys(uiPackage.dependencies ?? {});
assert(
  !uiDependencies.some((dependency) => /tauri|audio-client/i.test(dependency)),
  'Shared UI must not depend on audio-client or Tauri.',
);
assert.deepEqual(Object.keys(webPackage.dependencies ?? {}).sort(), [
  '@loopbeats/audio-client',
  'react',
  'react-dom',
]);
assert(
  !Object.keys(webPackage.devDependencies ?? {}).some((dependency) =>
    /tauri/i.test(dependency),
  ),
  'The Web workspace must not require Tauri packages.',
);
assert.deepEqual(Object.keys(audioClientPackage.dependencies ?? {}).sort(), [
  '@loopbeats/domain',
  '@loopbeats/session-format',
]);

const sharedUiFiles = [
  ...(await sourceFiles('packages/ui/src')),
  ...(await sourceFiles('packages/domain/src')),
  ...(await sourceFiles('packages/session-format/src')),
];
for (const path of sharedUiFiles) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /@tauri-apps\/|\b(?:AudioContext|AudioWorkletNode|AudioWorklet|MediaStreamAudioSourceNode|navigator|window|document|localStorage|indexedDB)\b|(?:mediaDevices\s*\.\s*getUserMedia|getUserMedia\s*\()/,
    `${path} must stay independent of Tauri and concrete browser APIs.`,
  );
}
const webHostFiles = await sourceFiles('apps/web/src');
for (const path of webHostFiles) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /@tauri-apps\/|\b(?:AudioContext|AudioWorkletNode|AudioWorklet|MediaStreamAudioSourceNode)\b|(?:mediaDevices\s*\.\s*getUserMedia|getUserMedia\s*\()/,
    `${path} must use audio-client for browser audio and must not depend on Tauri.`,
  );
}

const cargoManifest = async (path) =>
  readFile(new URL(`../${path}/Cargo.toml`, import.meta.url), 'utf8');
for (const [name, path] of [
  ['LoopEngine', 'crates/loop-engine'],
  ['native audio host', 'crates/native-audio-host'],
]) {
  const manifest = (await cargoManifest(path)).toLowerCase();
  assert.doesNotMatch(
    manifest,
    /\b(?:tauri|windows(?:-sys|-core|-bindgen)?|wasapi|web-sys|wasm-bindgen)\s*=/,
    `${name} must not declare a browser, Windows, or desktop-shell dependency.`,
  );
  if (name === 'LoopEngine') {
    assert.doesNotMatch(
      manifest,
      /\b(?:native-audio-host|windows-audio-host)\s*=/,
      'LoopEngine must not depend on platform host crates.',
    );
  }
  for (const file of await filesUnder(`${path}/src`, ['.rs'])) {
    const source = await readFile(
      new URL(`../${file}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /\b(?:windows|wasapi|tauri|web_sys|wasm_bindgen)::|\b(?:AudioContext|AudioWorkletNode)\b/,
      `${file} must remain portable and independent of host APIs.`,
    );
  }
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
