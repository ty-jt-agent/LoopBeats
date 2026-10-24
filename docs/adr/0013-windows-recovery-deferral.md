# Defer Windows automatic recovery until after the audio prototype

## Status

Accepted, 2026-10-24.

## Context

The first Windows prototype is intended to establish native audio correctness,
complete monitoring latency, stream stability, and the agreed response to
confirmed capture loss. Periodic checkpoints and crash recovery would add
storage, snapshot consistency, and restore behavior before the audio path and
bounded session-transfer costs have been validated.

## Decision

Keep manual portable session import/export in the planned Windows integration
scope, using the shared TypeScript session-format implementation and a bounded
native transfer path as described in [ADR-0012](0012-shared-session-format-package.md).
Defer Windows automatic crash recovery and periodic recovery checkpoints until
after the audio prototype. They are outside prototype acceptance. Preserve the
platform boundary for a future Windows recovery adapter, but do not add
speculative recovery infrastructure during the prototype. Existing Web
recovery behavior remains unchanged.

After prototype audio validation and session-transfer measurements, revisit
whether Windows recovery is a first-release priority. If recovery is deferred
beyond the first release, release documentation must state that unsaved work
cannot be restored after a crash.

## Consequences

The prototype can focus on real-time processing and measured bounded session
transfer without defining Windows checkpoint cadence, recovery prompts, crash
consistency, or durable snapshot storage. Manual export remains the user's
portable persistence path during this phase. The later release decision must
account for measured memory, responsiveness, and snapshot ownership costs.

This decision changes Windows scope only; it does not supersede the browser
recovery requirements in [ADR-0002](0002-portable-sessions-and-recovery.md).
