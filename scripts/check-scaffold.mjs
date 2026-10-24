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
console.log(
  `Scaffold valid: ${required.length} paths, ${skills.length} project skills.`,
);
