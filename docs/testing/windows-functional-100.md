# Windows shared-UI functional slice (#100)

Status: automated workflow covered; Windows hardware acceptance remains pending.

## Automated evidence

- `apps/windows/src/windows-audio-workflow.test.tsx` runs the shared React UI through `WindowsAudioApplication` and a controlled native-command bridge for startup, monitoring, two Loop captures, overdub start/finish, Input Low-pass enablement, acknowledged FX state, and interruption consequences.
- `apps/windows/src/windows-audio-application.test.ts` covers native application outcomes, generation changes, snapshot polling, and explicit interruption reinitialization.
- `crates/native-audio-host/tests/command_contract.rs` covers render-boundary FX application, acknowledged effect state, copied engine snapshots, monitoring changes, initial-capture discard on interruption, generation invalidation, and bounded native command behavior.
- `cargo check -p windows-audio-host --target x86_64-pc-windows-msvc` verifies the Windows-specific WASAPI implementation.
- The full Rust workspace suite, Vitest suite, TypeScript checks, lint/format checks, Windows frontend build, and the Web FX-editor Playwright suite passed for this change set.

## Hardware evidence

The WASAPI device workflow was not run on Windows hardware in this environment. H01 remains deferred in [the shared manual case catalog](manual-validation.md); no latency, dropout, or listening result is claimed.
