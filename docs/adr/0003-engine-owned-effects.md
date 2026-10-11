# Engine-owned effects and atomic session configuration

Status: design selected under owner delegation, 2026-10-11; reviewed specification
and ready tickets are still required before implementation.

## Context and decision

The engine already owns mono capture, additive overdub, independent track signals
and their mix; its browser bridge exposes only the final mixed output. Keep Input,
independent Track and Master DSP in the portable Rust engine, with bounded fixed
filter slots and engine-owned configuration/history. This preserves one sample
timeline, processed-once input capture and atomic audio/FX session replacement.
The browser host owns I/O and persistence; React displays acknowledged controls.

## Alternatives and consequences

Web Audio nodes would require new track-output signals and capture/gain routing
changes. A hybrid would split DSP history and transactional ownership without a
necessary benefit for four first-delivery filters. Rust requires explicit DSP
tests and device measurements; it does not establish sonic parity with BOSS or a
latency guarantee. FX configuration travels with versioned sessions, while history
is reset on restoration. Do not add a general chain/plugin system or stereo format
change for this first filter delivery. See the [design brief](../specs/effects-design-brief.md).
