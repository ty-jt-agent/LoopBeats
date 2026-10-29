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

The current PnP signed-driver query reports `Realtek High Definition Audio` version `6.0.9945.1` (Realtek Semiconductor Corp., dated `2026-01-20`) and `USB Audio Device` version `10.0.26100.9457` (Microsoft, dated `2026-09-12`). The USB audio function is a child of the present `USB\VID_1E71&PID_2606` composite device, which also exposes `NZXT USB MIC`.

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
| #103 integrated WASAPI hardware acceptance | Incomplete | The integrated app workloads and an overdub-interruption response were observed below, but the fixture capture, endpoint identity/settings, host fault/occupancy trace, UI/IPC stress, fallback, other endpoint pairs, and acoustic pulse analysis remain missing. No latency or stability acceptance pass is claimed. |

## Integrated Tauri app observations

The integrated Tauri window was accessible on this machine. These runs used
`HostConfig::default()` at 48 kHz. The app does not expose the resolved capture
or render endpoint identities, negotiated period/buffer, fallback state, host
discontinuity counters, or capture-buffer occupancy. Its input/output meters
are hard-coded to zero. The observations below establish visible workload and
session behavior only; they are not a hardware stability or acoustic latency
pass. The tester reported that the calibrated fixture was connected and its
automatic sequence was running, but the fixture model, capture location, and
recorded pulse data were not provided or accessible during these runs.

### Windows endpoint inventory

Windows PnP enumeration on this machine reported these candidate endpoints.
This is an inventory only: endpoint status does not establish the active
default route or physical headphone/coupler connection.

| Direction | Endpoint | Endpoint ID | PnP status |
| --- | --- | --- | --- |
| Capture | NZXT USB MIC | `{0.0.1.00000000}.{B45C7182-9207-4C3E-B8BA-F55E05C6C4EC}` | OK |
| Render | NZXT USB MIC | `{0.0.0.00000000}.{5112030B-81FC-49F9-99B0-97D64C395968}` | OK |
| Capture | Realtek microphone array | `{0.0.1.00000000}.{919FC9FC-A773-49B7-97F5-33357FB4FDDE}` | OK |
| Render | Realtek Audio speakers | `{0.0.0.00000000}.{65382691-D1DF-488D-8228-A312AF984555}` | OK |
| Render | USB Audio Device | `{0.0.0.00000000}.{CBD54A6C-A82E-4F2C-B3D8-68ABB5B43839}` | Unknown |
| Render | Realtek Audio headphones | `{0.0.0.00000000}.{C5E79CC9-727D-42A9-BF91-54FDA54B291A}` | Unknown |

NZXT-to-NZXT is a matched-endpoint candidate. NZXT capture to Realtek render
is a separate-endpoint candidate; independent clocks and the physical routes
still need confirmation. The `USB Audio Device` endpoint is associated with
the NZXT USB composite device; the reported acoustic fixture itself remains
unidentified.

| Workload | Start / observed end (Asia/Taipei) | App state and result |
| --- | --- | --- |
| Representative load | 14:24:27–14:54:29 (30 minutes 2 seconds) | Both Loop tracks played on the shared 123,840-sample cycle; monitoring was on; the input low-pass filter was active at 611 Hz; Track 1 was observed in Overdubbing state at approximately 40–50 second UI checkpoints; the continuous active-overdub duration and commands between checkpoints were not recorded, so this does not establish the required representative workload. No UI commands were sent during the interval. The processed-frame counter advanced from 45,479,616 to 132,096,096. No app-level interruption appeared. Host discontinuity counts and per-second occupancy were unavailable. |
| Effect plus two-track playback (not the required effect-only workload) | 14:54:49–15:24:53 (30 minutes 4 seconds) | Both Loop tracks played; monitoring and the 611 Hz input low-pass filter were on; no track was overdubbing. The app remained ready at approximately 40–50 second UI checkpoints and reported no interruption. Host discontinuity counts and per-second occupancy were unavailable. |
| Monitoring-only passthrough | 15:25:33–15:55:44 (30 minutes 11 seconds) | Monitoring remained on; both tracks and transport were stopped; the input low-pass filter was bypassed. The app remained ready at approximately 40–50 second UI checkpoints and reported no interruption. The physical input/output route was not identified or independently verified. |

### Capture interruption during representative load

- First attempt started at 14:14:46 and was interrupted at approximately
  14:22:28 (7 minutes 42 seconds) while both tracks were playing, monitoring
  was on, the input low-pass filter was active, and Track 1 was overdubbing.
- The app reported: “Capture interrupted. Transport reset and monitoring
  turned off. Completed recordings were retained. Track 1 overdub may be
  partial; additions already written were retained.” This demonstrates the
  expected user-facing recovery response during overdub.
- After manual reinitialization, Track 1 and Track 2 diagnostics each showed
  123,840 captured samples and 123,840 Loop samples. The app did not report the
  exact number of newly added overdub samples, so exact addition retention is
  not established.
- The app did not retain/show the interruption reason or host diagnostics after
  the event. Whether this was fixture-driven or an unexpected capture fault is
  unknown. The separate 30-minute representative rerun above passed this
  interruption point without another app-level interruption.

These observations do not satisfy the issue's stability gate because the
integrated UI provides no host fault counters or occupancy trace. They also do
not replace a controlled capture-loss case with recorded host reason and exact
sample-retention evidence.

## Additional checks

- `npm run tauri:dev` compiled and opened the integrated `LoopBeats` window. The app was later accessible through Windows computer use; monitoring, effects, both tracks, overdub, and capture-interruption UI behavior were exercised as recorded above.
- `npm run test:windows`: 3 files and 7 tests passed. The run also printed `Not implemented: navigation to another Document`.
- `cargo test --locked -p windows-audio-host`: 25 tests passed; doc-tests had no tests.

These automated checks and the successful app build do not replace the physical runs or acoustic measurements. Do not treat this report as a latency or hardware-acceptance pass. Required follow-up includes investigating the Realtek packet gaps and NZXT WASAPI discontinuities, confirming physical headphone routes, USB microphone with built-in wired output, and an independently clocked pair; each requires the separate workloads, fixture calibration, pulse accounting/statistics, stability durations, and interruption checks specified in issue #103.

## Current-session hardware discovery and instrumentation limits

On 2026-10-29, Windows enumeration showed the NZXT USB MIC capture/render endpoints and Realtek microphone-array/speaker endpoints. The running-app inventory showed LoopBeats, Firefox, and Notepad++; no recorder or fixture application was visible. A generic USB mass-storage device was present, but Windows exposed no mounted media on it. I did not find a synchronized two-channel fixture capture in the accessible locations. This does not establish that the owner-reported fixture is physically disconnected; its recorder and output path are simply not exposed to this session.

The diagnostics implementation on branch `issue-103-native-diagnostics` adds endpoint/driver/format/period/buffer/fallback and live host counters to the integrated app, with a downloadable JSONL trace sampled by the WebView at approximately one-second intervals. Because that sampler runs in WebView JavaScript, samples can be absent during a WebView stall. It is useful during responsive intervals but does not satisfy the issue's once-per-second occupancy evidence across the required 30-second stall. The existing hardware runs above predate this instrumentation and were not made with the diagnostics UI in the binary.

The effect-plus-two-track interval is not the required effect-only case. The representative-load interval records Overdubbing only at occasional UI checkpoints, so continuous active overdub during that run is unverified. Neither interval is marked as a full #103 case pass.
## Branch diagnostics smoke

- Commit under test: `290d4ca` (`issue-103-native-diagnostics`), rebuilt with `npm run tauri:dev`.
- Route resolved by the integrated app: NZXT USB MIC capture (`{0.0.1.00000000}.{b45c7182-9207-4c3e-b8ba-f55e05c6c4ec}`) to Realtek Audio render (`{0.0.0.00000000}.{65382691-D1DF-488D-8228-A312AF984555}`), both 48 kHz Float32; 480-frame periods, 1,056-frame buffers, no fallback. Monitoring was off; no external stimulus or track playback was used, and the physical output connection was not verified.
- Trace: [29 samples](traces/wasapi-2026-10-29T09-33-06Z.jsonl), 2026-10-29 17:33:06.698–17:33:35.084 Asia/Taipei (28.386 seconds). Sample gaps ranged from 1.000 to 1.050 seconds.
- Capture discontinuities stayed at 1 from first to last sample; capture overflows 0; render failures 0; device-failed false. Capture queue occupancy ranged 384–1,705 of 16,384 frames; resampling correction ranged -2,689 to +2,286 ppm. The one discontinuity existed in the first sample and was classified `wasapi-reported` / `playback-continued`; this run does not identify its cause.
- Result: diagnostics wiring and export verified on the connected endpoints. This short idle-track observation is not an acceptance-duration run, does not characterize the drift range over time, and provides no acoustic latency or fixture pulse evidence.