# Settings Audio input verification (#64)

This is the issue-specific replacement for the corresponding part of PR #70.
It follows [the accepted interaction contract](../specs/settings-interaction-contract-62.md),
covering S16 and the shared focus/layout cases. The other three feature slices are separate PRs.

The branch targets `main` directly and needs no sibling PR to merge.
The focus restoration fix is the same commit shared by all four PRs.
Engine, archive and storage policy remain unchanged.

## Validation

The standalone branch passed 28 focused production-browser cases in
`settings-audio.spec.ts, input-devices.spec.ts, input-retention.spec.ts, settings-panel.spec.ts and responsive-accessibility.spec.ts` and all 87 unit tests. TypeScript, ESLint, Windows-compatible Prettier
(`--end-of-line auto`), production/WASM build and `git diff --check` passed.
The PR's CI additionally runs the entire browser suite, `npm run check`, native
Rust tests, Rust format/Clippy and the WASM build against this branch.

Routine physical audio/interface acceptance remains deferred to #19. No hardware
result is claimed here.
