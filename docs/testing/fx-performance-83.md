# FX load and device evidence (#83)

This record separates repeatable synthetic engine measurements from physical
audio acceptance. Synthetic throughput is not a real-time guarantee: this runner
does not schedule against a browser audio callback, exercise browser checkpoint
storage, or listen to a device.

## Reproduce pure engine measurements

Run the optimized native workload from the repository root:

```bash
cargo run --locked --release -p loop-engine --example fx-load -- 600
```

The final argument is simulated playback duration in seconds (default 600). The
runner tests 8, 44.1, 48 and 192 kHz with baseline, four active filters, and four
configured warm-bypassed filters. Each track is imported at its existing 60-second
capture capacity, both tracks play together, monitoring is on, and the workload
edits FX targets and toggles overdub during processing. It reports callback-time
percentiles, sampled maximum, and calls exceeding the nominal block budget. Timing
includes the runner's measurement overhead. The active/bypass edits are synthetic;
they do not reproduce a person editing the production UI.

This native runner does not measure WASM memory, the host worklet scheduler,
checkpoint serialization or browser storage, foreground UI contention, physical
glitches, perceived transition quality, or acoustic output. `two_track_sample_bytes`
is the raw sample payload for the imported recordings; it is not total engine or
WASM memory. Do not use native callback percentiles as device support claims.

For actual WASM/worklet regression coverage, run:

```bash
npm run test:browser:fx
npm run test:browser
```

These suites verify functional browser/worklet behavior. They do not constitute a
10-minute performance or physical listening test.

Measure WASM linear-memory growth after compiling the current engine with
`npm run build:audio`, then run `node scripts/fx-wasm-memory.mjs`. This compares
baseline configuration with four configured filter slots at each engine rate; it
does not measure total browser process memory.

The existing deterministic and browser suites provide the behavior record against
#76: [engine Input FX tests](../../crates/loop-engine/tests/input_fx.rs), [Track FX
tests](../../crates/loop-engine/tests/track_fx.rs), [Master FX tests](../../crates/loop-engine/tests/master_fx.rs), [production Input FX
workflows](../../apps/web/tests/browser/input-fx.spec.ts), [Track/Master WASM
workflows](../../apps/web/tests/browser/track-fx.spec.ts), [FX editor
accessibility/responsive workflows](../../apps/web/tests/browser/fx-editor.spec.ts)
and [recovery workflows](../../apps/web/tests/browser/session-recovery.spec.ts).
They verify known-sample signal behavior, sample timing, lifecycle, persistence,
recovery and production keyboard/touch layouts. Passing them is functional
automated evidence, not physical listening or real-time load acceptance.

## Physical run record

No physical-device run has been performed for this change. Complete one row per
setup on the same final candidate build. Use FX01–FX03 in
[manual-validation.md](manual-validation.md), and record build/commit, device and
OS, browser version, actual context sample rate, render quantum size, memory before
and after initializing the engine, processing-time distribution and maximum,
deadline-miss diagnostics, and audible clicks/dropouts. Exercise checkpointing and
busy UI load during the 10-minute run. Label automated/synthetic and physical
observations separately. Do not infer browser host rate support from engine-only
rate tests.

| Setup | Build / commit | Rate / block | WASM memory delta | Processing p50 / p95 / p99 / max | Misses / audible glitches | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Desktop Chrome + wired audio | Pending physical run | — | — | — | — | Deferred |
| iPad Safari | Pending physical run | — | — | — | — | Deferred |
| iPhone Safari | Pending physical run | — | — | — | — | Deferred |

For every claimed supported configuration, attach the raw diagnostics and note
browser/OS versions and wired or built-in audio path. If no reliable deadline-miss
counter is available, write “not exposed”; do not substitute the absence of a
visible failure. A measured budget failure restricts that configuration until a
fix or owner-approved limitation is recorded. Sonic parity with BOSS is outside
this evidence.

## Synthetic run: 2026-10-13

Commit at run: `9f417dd` (`docs: add reproducible FX acceptance evidence`).
Runner: Rust 1.98.1 release build, x86_64 WSL2 on a 13th Gen Intel Core
i5-13450HX, Linux 6.6.87.2-microsoft-standard-WSL2, Node 24.21.0. Browser and
audio hardware: not used. Simulated playback: 600 seconds per rate/scenario,
128-sample engine blocks, two 60-second tracks. The reported p50/p95/p99 and
maximum are sampled once per 100 callbacks; the deadline counter checks each
callback against the nominal 128-sample block budget. `Instant` calls are part of
the measured loop. This run did not model the required busy UI or full checkpoint
serialization/storage transfer.

| Rate | Scenario | Sampled p50 / p95 / p99 / max (ns) | Callback budget misses | Run wall time |
| ---: | --- | ---: | ---: | ---: |
| 8 kHz | Baseline | 1,884 / 2,319 / 3,112 / 11,060 | 0 / 37,500 | 0.076 s |
| 8 kHz | Four active | 3,023 / 3,449 / 6,921 / 15,626 | 0 / 37,500 | 0.133 s |
| 8 kHz | Four warm-bypassed | 2,994 / 3,401 / 8,234 / 13,066 | 0 / 37,500 | 0.135 s |
| 44.1 kHz | Baseline | 1,854 / 2,074 / 2,713 / 13,368 | 0 / 206,719 | 0.411 s |
| 44.1 kHz | Four active | 2,970 / 11,168 / 13,073 / 35,912 | 0 / 206,719 | 1.093 s |
| 44.1 kHz | Four warm-bypassed | 2,966 / 11,163 / 12,679 / 241,348 | 0 / 206,719 | 1.100 s |
| 48 kHz | Baseline | 1,831 / 2,062 / 2,882 / 21,530 | 0 / 225,000 | 0.444 s |
| 48 kHz | Four active | 2,955 / 16,660 / 18,316 / 73,364 | 0 / 225,000 | 1.229 s |
| 48 kHz | Four warm-bypassed | 2,946 / 16,623 / 18,239 / 188,381 | 0 / 225,000 | 1.229 s |
| 192 kHz | Baseline | 1,837 / 2,055 / 2,556 / 39,582 | 0 / 900,000 | 1.769 s |
| 192 kHz | Four active | 2,979 / 21,813 / 28,249 / 295,863 | 2 / 900,000 | 10.732 s |
| 192 kHz | Four warm-bypassed | 2,974 / 21,693 / 27,407 / 491,863 | 4 / 900,000 | 10.707 s |

These figures show engine execution on this runner only. Callback-budget misses at
192 kHz include timer/instrumentation and host scheduling overhead; they do not
establish audio dropouts. Sampled maximum is not the maximum of every callback.
The run does not qualify any browser/device configuration.

The compiled module was 60,828 bytes. The standalone WASM linear-memory probe
reported initialization memory of 9,371,648 bytes at 8 kHz, 46,465,024 bytes at
44.1 kHz, 50,135,040 bytes at 48 kHz, and 197,197,824 bytes at 192 kHz. Configuring
four filters changed linear memory by 0 bytes at each rate. These values describe
the module's WebAssembly memory only, not browser AudioContext, JS, or page memory.

The release limits remain two tracks, four mono filter slots, and existing capture
and archive capacities. Delay/reverb, stereo, additional slots, rendered output,
and running-engine sample-rate migration remain deferred.
