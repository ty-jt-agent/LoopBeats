# Input FX tracer bullet (#77)

Input FX now processes mono incoming audio once in the Rust engine, before
capture, overdub additions and monitoring. Playback does not run stored samples
through Input FX again. Track and Master slots expose their default bypassed
configuration but do not process audio until their own tickets land.

Four fixed slots are initialized with constant-size state. The Input low-pass
uses the response, bounds, warm bypass, sample-counted ramps and structural
removal contract in #76 and ADR-0003. The host sends one Input configuration
command at a time and coalesces pending cutoff changes to the latest target.
Engine snapshots acknowledge targets and transitions; rejected commands retain
configuration. Numerical failure stops processing through the audio-error
lifecycle before non-finite values reach recordings or output.
The output mix accumulates in float64 before final master gain/clamp so finite
over-range playback plus monitoring cannot overflow to NaN at master gain zero.

Global STOP clears Input history and ramps while retaining configuration and
explicit monitoring. Reset installs default bypassed FX; interruption retains
configuration with fresh history and monitoring off. Successful input switching
uses the existing processing-side Global STOP after browser source replacement;
failed switching does not reset DSP. Local track actions do not clear Input
history. Stop audio discards the engine and its FX configuration.

## Preview gate

Normal development/production builds expose no FX controls. The explicit
`VITE_INPUT_FX_PREVIEW=true` build enables an inline Input-only preview for this
tracer bullet. The preview explains that ZIP and recovery do not yet preserve FX.
This is not the public editor or persistence release: #78/#79 and the remaining
scopes must land before #82 removes the gate. Preview settings never enter
global preferences. Do not use this build to promise portable FX restoration.

Run `npm run test:browser:input-fx` to build the gated production preview and test
the actual UI/worklet/WASM path. Run the normal `npm run build` afterward to
restore a build without preview controls. CI tests both builds. The ordinary
browser suite includes a test proving a URL query cannot enable preview controls
in a normal production build.

## Verification

Public engine tests cover known impulse samples, settled frequency response at
8/44.1/48/192 kHz, cutoff bounds, exact ramps/removal, warm bypass, block-independent
timing, invalid commands, finite over-range storage, numerical failure and no
allocation during commands/capture/processing. Actual offline worklet/WASM tests
verify baked samples, dry playback and exactly-once overdub, duplicated output
channels and invalid configuration rejection. Production preview tests cover
acknowledged edits during capture/playback, removal/re-add, phone width, error
feedback and bounded command coalescing.
Repeated filtered overdub tests use independent impulse fixtures, and real-host
input-switch tests cover success, rejection and acquisition abandoned by a
concurrent capture without inventing an atomic browser graph swap.

Physical listening and device load evidence are deferred to #83. No numerical
CPU/headroom, latency, proprietary BOSS sonic parity or hardware pass is claimed.
See FX01–FX03 in the shared manual case catalog.
