# Windows WASAPI acceptance run (partial)

Reported 2026-10-29. This is a short diagnostic run of the standalone monitor harness, not an integrated #103 acceptance run. The harness does not report its elapsed duration; tool observations place the run at approximately four minutes. Exact duration was not recorded.

## Setup

- Checkout: `main`, aligned with `origin/main`; reported candidate commit `2531b7c`
- Host: ASUS TUF Gaming F16 FX608JM_FX608JM
- OS: Windows 11 Home, version `10.0.26200`, build `26200`, x64
- Harness: `cargo run --locked -p windows-audio-host --example monitor`
- Workload: standalone native passthrough monitor; no Loop tracks, overdub, effect, UI/IPC stress, capture interruption, or external acoustic stimulus
- Physical route: NZXT USB MIC capture to Realtek output; wired headphone connection and listening result were not verified
- Tester confirmed the calibrated synchronized recorder and acoustic fixture are connected and calibrated; they were not used or documented in this run. Recorder model/rate, reference-mic and coupler geometry, channel skew, propagation/coupler corrections, residual uncertainty, and detector thresholds remain to be recorded.
- Scheduled/reference/matched/missed pulse counts: not collected

## Negotiated stream settings

| Stream | Endpoint | Rate | Format / channels | Period | Buffer | Fallback |
| --- | --- | ---: | --- | ---: | ---: | --- |
| Capture | `NZXT USB MIC` (`{0.0.1.00000000}.{b45c7182-9207-4c3e-b8ba-f55e05c6c4ec}`) | 48,000 Hz | Float32 / 1 | 480 frames (10 ms) | 1,056 frames | None |
| Render | `Realtek(R) Audio` (`{0.0.0.00000000}.{65382691-d1df-488d-8228-a312af984555}`) | 48,000 Hz | Float32 / 2 | 480 frames (10 ms) | 1,056 frames | None |

The Realtek PnP signed-driver query returned `Realtek High Definition Audio`, version `6.0.9945.1` (provider shown as Microsoft; date `2026-01-20`). The NZXT driver version was not identified by that query and remains pending Device Manager confirmation.

## Initial short diagnostic run

| Counter / state | Value |
| --- | ---: |
| Capture discontinuities | 1 |
| Capture overflows | 0 |
| Render failures | 0 |
| Device failed | false |
| Capture queue occupancy | 960 / 16,384 frames |
| Capture resampling correction | 0 ppm |
| Latest discontinuity | `WasapiReported`; impact `PlaybackContinued` |

The discontinuity count was already 1 in the initial diagnostic snapshot and remained 1 at shutdown. Its cause and timing were not characterized. The proposed stable-run gate requires zero unexplained discontinuities, so this short run does not satisfy that gate and needs a focused reproduction. No complete mic-to-output latency was measured.

## Follow-up standalone stability observation

- Started: `2026-10-29 11:40:27` Asia/Taipei
- Stopped: `2026-10-29 12:10:31` Asia/Taipei (30 minutes 4 seconds by process timestamps)
- Workload and endpoints: same standalone NZXT USB MIC to Realtek monitor route above; no acoustic stimulus or LoopBeats UI workload.
- Initial and final diagnostics: one capture discontinuity, zero overflows, zero render failures, `device_failed: false`, 960 queued capture frames of 16,384 capacity, 0 ppm correction, and no fallback.
- The discontinuity count did not increase during the observation. The existing event remained classified as `WasapiReported` with impact `PlaybackContinued`; its cause and exact time are unavailable from this harness.
- Result: no additional reported stream faults during this 30-minute standalone observation. It does not meet the issue's integrated-workload stability gate and does not establish acoustic latency.

## Realtek microphone to Realtek output observation

- Started: `2026-10-29 12:50:59` Asia/Taipei
- Stopped: `2026-10-29 13:21:00` Asia/Taipei (30 minutes 1 second by process timestamps)
- Harness: explicit Realtek microphone-array capture endpoint `{0.0.1.00000000}.{919FC9FC-A773-49B7-97F5-33357FB4FDDE}` to Realtek output endpoint `{0.0.0.00000000}.{65382691-D1DF-488D-8228-A312AF984555}`.
- No acoustic stimulus or LoopBeats UI workload was used. The physical output connection was not verified, so this does not establish the built-in-microphone-with-wired-headphones acceptance configuration.

| Stream | Rate | Format / channels | Period | Buffer | Fallback |
| --- | ---: | --- | ---: | ---: | --- |
| Capture | 48,000 Hz | Float32 / 2 | 64 frames (about 1.33 ms) | 140 frames | None |
| Render | 48,000 Hz | Float32 / 2 | 480 frames (10 ms) | 1,056 frames | None |

- Initial diagnostics: 4 capture discontinuities, 0 overflows, 0 render failures, `device_failed: false`, 0 ppm correction.
- Final diagnostics: 15,047 capture discontinuities, 0 overflows, 0 render failures, `device_failed: false`, 717 / 16,384 queued capture frames, and -2,542 ppm correction.
- The discontinuity count increased by 15,043 during the run. The latest event was `CapturePacketGap`, with impact `PlaybackContinued`. The host increments this counter when WASAPI reports a discontinuity or a capture packet index does not match the prior packet end; this run's latest event was the latter. The monitor does not retain event timestamps or a per-second trace.
- Result: failed the zero-unexplained-discontinuity stability gate by a wide margin. No latency was measured. Investigate the packet-gap behavior before repeating this route or treating it as a hardware result.

## Matched NZXT USB microphone and output observation

- Started: `2026-10-29 13:21:47` Asia/Taipei
- Stopped: `2026-10-29 13:51:34` Asia/Taipei (29 minutes 47 seconds by process start and stop observations)
- Harness: explicit NZXT USB MIC capture endpoint `{0.0.1.00000000}.{B45C7182-9207-4C3E-B8BA-F55E05C6C4EC}` to NZXT USB MIC output endpoint `{0.0.0.00000000}.{5112030B-81FC-49F9-99B0-97D64C395968}`.
- No acoustic stimulus or LoopBeats UI workload was used. The physical output connection and listening result were not verified.

| Stream | Rate | Format / channels | Period | Buffer | Fallback |
| --- | ---: | --- | ---: | ---: | --- |
| Capture | 48,000 Hz | Float32 / 1 | 480 frames (10 ms) | 1,056 frames | None |
| Render | 48,000 Hz | Float32 / 2 | 480 frames (10 ms) | 1,056 frames | None |

- Initial diagnostics: 1 capture discontinuity (`WasapiReported`), 0 overflows, 0 render failures, `device_failed: false`, 0 ppm correction.
- Final diagnostics: 97 capture discontinuities, 0 overflows, 0 render failures, `device_failed: false`, 960 / 16,384 queued capture frames, and -2 ppm correction.
- The discontinuity count increased by 96. The latest reason was `WasapiReported`, with impact `PlaybackContinued`.
- Result: failed the zero-unexplained-discontinuity stability gate. No latency was measured; the monitor does not retain individual event timestamps or a per-second trace.

## Result and remaining acceptance work

| Case | Result | Evidence / limitation |
| --- | --- | --- |
| Standalone passthrough monitor diagnostic | Inconclusive; one unexplained capture discontinuity observed | Initial short run had one event. A separate 30-minute run observed no additional faults, but the original discontinuity remains unexplained; physical headphone route and listening outcome were not verified. |
| Realtek mic-array to Realtek output monitor | Failed standalone stability observation | 30 minutes 1 second; discontinuities increased from 4 to 15,047, latest `CapturePacketGap`; no overflow or render failure. Physical wired-headphone route and listening outcome were not verified. |
| Matched NZXT microphone and output monitor | Failed standalone stability observation | 29 minutes 47 seconds; discontinuities increased from 1 to 97, latest `WasapiReported`; no overflow or render failure. Physical output route and listening outcome were not verified. |
| #103 integrated WASAPI hardware acceptance | Blocked / incomplete | No acoustic capture or pulse analysis; no 1,000-pulse trials; no integrated two-track/overdub/effect/UI stress workloads; other endpoint configurations and interruption cases remain untested. The standalone monitor observations do not satisfy the integrated workload gate. |

## Additional checks

- `npm run tauri:dev` compiled and opened the integrated `LoopBeats` window. The computer-use tool denied UI access with `Computer Use was not approved to use loopbeats-windows`, so audio was not started and no microphone permission prompt was acted on.
- `npm run test:windows`: 3 files and 7 tests passed. The run also printed `Not implemented: navigation to another Document`.
- `cargo test --locked -p windows-audio-host`: 25 tests passed; doc-tests had no tests.

These automated checks and the successful app build do not replace the physical runs or acoustic measurements. Do not treat this report as a latency or hardware-acceptance pass. Required follow-up includes investigating the Realtek packet gaps and NZXT WASAPI discontinuities, confirming physical headphone routes, USB microphone with built-in wired output, and an independently clocked pair; each requires the separate workloads, fixture calibration, pulse accounting/statistics, stability durations, and interruption checks specified in issue #103.
