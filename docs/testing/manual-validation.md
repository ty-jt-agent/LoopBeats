# Shared physical-audio validation

Owner: the project's one manual tester. Tracker: [#19](https://github.com/ty-jt-agent/LoopBeats/issues/19). Follow [strategy.md](strategy.md). This catalog covers the first usable two-track desktop milestone, not the later five-track/cross-device product.

## Run once, reuse setup

Use desktop Chrome, a working microphone and wired headphones. Open the candidate build and record the setup below. Start audio once; keep monitoring off except where required. Cases can share the same recordings and session. Never turn a deferred checkbox into a claimed pass.

| ID | Combined case and expected outcome | Origin / affected features |
| --- | --- | --- |
| M01 | Start and allow capture; monitoring is initially off. Toggle it on/off and confirm live input is heard only when enabled. Stop/restart the audio session and confirm resource release and monitoring reset. Deny permission once, confirm actionable recovery, then allow/retry. | #7; lifecycle, routing, permissions |
| M02 | Record a distinctive phrase on A, finish with REC, hear repeated content from the beginning in both outputs. Progress wraps and length remains fixed. Listen for unintended missing/repeated samples, clicks or dropouts. Distinguish waveform discontinuity clicks from timing errors. | #8; first Loop and output bridge |
| M03 | Verify first-recording track STOP retains audio silently; PLAY begins it. Verify the displayed 60-second limit/remaining time and automatic completion once. Individual track STOP preserves the running cycle; global STOP resets transport, retains completed audio and discards unfinished initial capture. | #9; bounds and transport |
| M04 | With A looping, record B halfway through the cycle. Verify equal length and audible phase alignment. Finish another synchronized capture early and confirm uncaptured positions are silent; retry across wraparound. | #10; synchronized capture |
| M05 | Overdub A across multiple cycles, finish mid-cycle, then stop/play. Additions are retained, length unchanged. Competing REC is unavailable. | #11; overdub and capture ownership |
| M06 | Record a One-shot, hear it once then stop; PLAY retriggers from zero. Check mode changes while stopped and rejection of incompatible Loop length. | #12–#13; One-shot and modes |
| M07 | Adjust track/master gain, mute/unmute while playing/capturing and confirm phase/capture continues. Listen for unexpected overload behavior. Verify CLEAR confirm/cancel/off setting; clearing preserves cycle and session reset removes it. | #14–#15; mixer and clear/reset |
| M08 | Change supported settings, reload and confirm settings persist while recordings do not. Confirm leave-page warning with recordings. With an available second input, switch only while stopped and verify retained completed audio/fallback. Trigger an available real interruption/disconnect and verify retained completed audio plus explicit recovery. Record unavailable hardware paths as blocked, not passed. | #16–#18; settings and lifecycle |
| M09 | Run the integrated two-track Loop/overdub mix for 10 minutes. During the same run exercise realistic main-thread/UI load for at least 30 seconds and watch progress. Note audible drift/dropouts, input/output delay and reported diagnostics. No numeric latency guarantee is inferred from listening. | #19; integrated stability and UI isolation |
| M10 | Export/import a distinctive two-track session. During Loop, One-shot and overdub capture wait for a recovery checkpoint, reload and explicitly recover. Confirm retained partial audio opens stopped, monitoring off, Loop phase/silent gaps retained and no resumed capture. Listen under UI load while checkpoints transfer; verify global STOP discards initial capture and recovery warns about unsaved newer work. | #50–#54; portable sessions and partial recovery; deferred to #19 |

At #19, map all 50 parent stories to automated or manual evidence. These combined cases complement that trace; they do not replace story-specific deterministic tests. If required hardware is unavailable, #19 stays unaccepted unless the owner explicitly narrows the target and records the limitation.

## Windows native audio prototype (#97)

Owner decision: defer completion of H01 until the integrated Windows audio product is ready. This case does not block intermediate implementation or code merges; it remains required before claiming Windows hardware acceptance. Use the standalone [`windows-audio-host` monitor harness](../../crates/windows-audio-host/README.md) and the measurement method and required evidence fields in [windows-native.md](../architecture/windows-native.md#owner-supplied-hardware-evidence).

| ID | Combined case and expected outcome | Origin / affected features |
| --- | --- | --- |
| H01 | On the available Windows x64 PC, run the native monitor on a matched duplex endpoint pair, record exact Windows/device/driver and negotiated settings, and provide repeatable complete mic-to-output measurement evidence or a specific documented measurement limitation. Record fallback and discontinuity status; keep low-period and fallback availability results distinct. | #97; native WASAPI, matched-endpoint monitoring and latency evidence |

| Case ID | Result | Evidence / limitation |
| --- | --- | --- |
| H01 | Deferred | [Partial owner-reported run](run-2026-10-26-windows-native-97.md) covers NZXT USB MIC to Realtek output: both at 48 kHz, 480-frame periods, no fallback; one additional discontinuity was counted. Complete H01 validation is deferred until the integrated Windows audio product is ready. Duration, listening outcome, driver versions and complete latency evidence or its limitation remain pending; do not mark H01 passed. |

## Existing evidence and deferred work

### Effects acceptance backlog (#83)

These cases cover the new FX delivery. They are deferred to #83 and do not reopen
closed #19 or imply its desktop report validates effects/mobile behavior.
Use the reproducible measurement and device record in
[fx-performance-83.md](fx-performance-83.md) for #83 evidence.

| Case ID | Focused procedure | Status / owner |
| --- | --- | --- |
| FX01 | With wired audio, enable Input filtering and monitoring, record a distinctive phrase, bypass, and replay. Confirm baked coloration remains; overdub adds newly processed input without repeatedly filtering the old recording. | Deferred; #83 |
| FX02 | Edit cutoff/bypass during capture and playback, remove/re-add, mute/STOP/CLEAR/reset, interrupt/reinitialize and switch available inputs. Listen for transition artifacts, follow documented history rules and record unavailable hardware paths. | Deferred; #83 |
| FX03 | On the final four-filter build run the specified ten-minute load with checkpointing and 30 seconds busy UI on desktop Chrome, iPad Safari and iPhone Safari. Record processing/memory evidence, clicks/dropouts and setup-specific limitations separately from synthetic tests. | Deferred; #83 |

| Evidence | Status | Reuse / limitation |
| --- | --- | --- |
| #5 browser audio spike | User-reported manual acceptance | Historical feasibility; use its research record, not a new mandatory per-PR run. |
| #6 WASM gain spike / PR #24 | User-reported manual acceptance | Historical feasibility, not integrated loop correctness. |
| M01 / #7 / PR #26 | Device checklist marked complete by user | Browser/hardware details were not recorded in the PR discussion. Reuse for intermediate slices; run once on the final candidate. |
| M02 / #8 / PR #27 | Deferred to #19 | Automated recording/stereo-output evidence passed; physical listening has not been performed/reported. |
| M03–M09 | Pending milestone implementation/validation | No pass is claimed. |

## Results format

Store run reports in this directory as `run-YYYY-MM-DD.md` (add a suffix for a second run that day), or link an equivalent #19 issue attachment/comment. Use one setup header for all cases in the run:

- Date / tester:
- Commit SHA / build URL:
- OS / browser version:
- Input / output hardware and connection (wired/USB/etc.):
- Sample rate and available latency diagnostics:

| Case ID | Result: passed / failed / deferred / blocked | Observation or diagnostic link | Bug / follow-up |
| --- | --- | --- | --- |
| M02 | deferred | Not yet performed | #19 |

The row above is an example of deferred status, not a completed test run. Reports must record actual observations. Separate estimated/perceived delay from measured values; do not invent metrics.

## Retest selection

Each PR lists affected IDs. A known failure gets one short reproduction and a linked bug. After its fix, rerun that case and any dependent cases (for example, a playback timing fix can affect M02–M06 and M09), using the previous setup when appropriate. For documentation-only changes, no listening is required. Do not rerun already accepted permission/monitoring cases for a recording-only slice without a concrete regression reason.
