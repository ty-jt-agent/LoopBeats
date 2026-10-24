# Portable session files and automatic recovery

## Status

Accepted product architecture decision, 2026-10-07. Implementation requires a
separate reviewed specification and ready tickets.

## Context

Recordings currently live in memory and do not survive a reload or shutdown.
Performers need a portable session file to continue later and automatic recovery
to reduce lost work after a crash. Saved application preferences alone do not
preserve recordings. The earlier [planning note](../architecture/future-session-import-export.md)
records the remaining implementation questions.

## Decision

Use two persistence paths with different purposes. Session export creates a
versioned ZIP containing `session.json` and one WAV per recorded track; it includes
completed recordings and the track/session data needed to continue editing and
playback: Loop/One-shot mode, track gain and mute, master gain, shared cycle length
and source sample rate. Unfinished recordings are excluded from manual export.
Automatic recovery maintains a browser-stored snapshot and offers recovery after
restart. It may include in-progress capture data; the exact incomplete-capture
and overdub recovery behavior remains open for the specification.

This browser recovery decision does not require Windows recovery in the native
audio prototype. Windows automatic recovery and checkpointing are explicitly
deferred pending prototype validation and session-transfer measurements; see
[ADR-0013](0013-windows-recovery-deferral.md). Manual portable session
import/export remains in the planned Windows integration scope, and this
deferral does not change Web recovery.

Import validates the complete archive before changing the live session. If the
archive sample rate differs from the current engine, the UI warns that conversion
will occur and may affect fidelity, and converts only after the user accepts.
If the current session contains recordings, replacement confirmation follows.
A successful import replaces the current session, leaves retained recordings
stopped (tracks without recordings remain Empty), resets transport position to
zero, and disables monitoring. Device identity, permissions and active capture
are never restored. Cancelled, rejected, malformed or unsupported imports leave
the current session unchanged.

Serialization, storage I/O, archive validation and resampling operate outside the
audio processing thread. Obtaining a consistent engine-owned snapshot still needs
a specified transfer mechanism that respects real-time constraints.

## Alternatives

A single opaque audio file would not preserve separately editable tracks and
session configuration. ZIP with separate WAV assets keeps the representation
inspectable and supports future migration. Manual export alone would require
performers to anticipate crashes; browser recovery alone would not provide a
portable backup. Rejecting all sample-rate differences would prevent direct
import across audio hosts, while silent conversion would hide a fidelity trade-off.

## Consequences

Browser recovery depends on successful storage writes and available quota.
Storage can be cleared or lost; a crash can lose changes newer than the last
completed checkpoint. Recovery is offered to the user rather than silently
replacing a session, and cannot guarantee preservation of every captured sample.
Write timing, retention, quota/write-failure feedback and incomplete-capture/
overdub semantics must be specified before implementation.

Full archive validation and conversion need bounded memory, capacity checks and
atomic replacement. Conversion takes time and may change sample values; duration,
shared-cycle alignment tolerances and the conversion algorithm need specification.
Consistent snapshots must preserve engine ownership without blocking processing.

Standalone track and mixed-output WAV downloads are deferred from this decision;
WAV files inside the session ZIP do not settle that separate feature's scope.
Schema/version migration, supported WAV formats and limits remain open in the
planning note.
