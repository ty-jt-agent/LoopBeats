# Settings workflows verification (#64–#67)

Scope: Audio input, portable ZIP actions, compact recovery, and the separate
Remove recordings area. The accepted
[Settings interaction contract](../specs/settings-interaction-contract-62.md)
governs these presentation changes. The prerequisite #63 is merged. Parent #61
and the engine, ZIP format, checkpoint cadence, ownership and deletion policy
are unchanged.

## Observable coverage

| Ticket | Contract cases | Production-browser evidence |
| --- | --- | --- |
| #64 | S16, shared focus/layout | `settings-workflows.spec.ts` checks opening without microphone access, disabled pre-start input, and an empty device list. `input-devices.spec.ts` and `input-retention.spec.ts` exercise acknowledged selection, running/capture restrictions, pending and failed/stale switching, retained recordings, fallback and persisted preference retry/reload. |
| #65 | S07–S10 | `session-export.spec.ts` verifies a downloaded ZIP's completed raw samples and settings while another track records, with visible capture/overdub blockers. Import/conversion tests verify actual round trips, full capacity, validation, consent ordering, cancellation, failure, lifecycle/stale requests and hidden-operation confirmation. `settings-panel.spec.ts` checks continuing export across tabs, dismissal and responsive transitions. |
| #66 | S11–S15 | `session-recovery.spec.ts` exercises real IndexedDB snapshots, reload/Later/reopen, frozen partial prefixes, stopped restoration, failed writes retaining the prior raw recording/settings, invalid records and ownership transfer. `settings-workflows.spec.ts` checks compact/details disclosure, unsupported storage and owner-held read failure without unsupported retries. Discard tests cover Cancel/Escape, failed deletion with another confirmed retry, and disabled cancellation while deletion commits, including Settings dismissal/reopening. |
| #67 | S19–S20 | Recovery and clear/reset tests verify deletion-first failure leaves recordings intact, reset/reload cannot resurrect removed recordings, and previous-workspace/non-owner copies remain. New 1280px/320px tests check Cancel focus, Escape, usable-trigger focus return, visible deletion consequences and successful retry. Failed CLEAR reports retrying its track's CLEAR rather than Reset. |

The public client exposes existing recovery failure/read-barrier observations for
presentation and returns an explicit dispatch result for CLEAR/reset. A sent
command is not an engine acknowledgement; the UI continues to read engine
snapshots for the resulting Empty/Stopped state. Recovery action flags and
deletion explanations share one presentation adapter.

The initial new workflow test failed because Save ZIP was absent. The first full
browser run also caught deferred close-focus restoration stealing focus from
Diagnostics. Settings now restores focus in the close commit, after modal inert
cleanup, without a deferred animation-frame callback. The existing keyboard
workflow covers this regression.

## Checks and review

The final production-browser suite passed all 157 tests with two workers; the
final unit suite passed all 87 tests. Scaffold, TypeScript, ESLint, Prettier
(`--end-of-line auto` for this Windows checkout), `git diff --check`, Rust format,
Clippy and production/WASM builds passed. Native `cargo test --locked --workspace`
cannot link locally because Windows `link.exe` is absent; Linux CI supplies the
native Rust test result.

Desktop Session and narrow Reset screenshots were visually inspected: the routine
ZIP controls precede Recovery, Reset is separated below them, and the named
confirmation retains visible Cancel/Confirm controls. Browser tests also cover
the 1024/1023 boundary, 320px layout, zoom-equivalent sizing and reduced motion.

## Standards

Independent Standards review found no remaining documented-standard violations
or actionable smell findings after centralizing recovery presentation, sharing
device refresh and distinguishing destructive dispatch outcomes.

## Spec

Independent Spec review found no remaining contract gaps after correcting failure
focus, track-specific CLEAR feedback, uncancellable discard feedback and recovery
source-retention explanations. Both reviews inspected the final close-focus fix.

Routine physical audio/interface acceptance remains deferred to #19 under the
shared testing strategy. This record does not claim those hardware cases passed.
