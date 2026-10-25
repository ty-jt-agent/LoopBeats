# Windows native monitor run (partial)

Reported 2026-10-26 for PR #110. The exact run date/time and duration were not
provided. This records the owner-supplied output without inferring listening or
latency results.

## Setup

- Host code: `c7659a6` (`feat: add native WASAPI monitoring host for #97`)
- Windows version/build: not provided
- Capture: `麥克風 (NZXT USB MIC)`, endpoint ID
  `{0.0.1.00000000}.{b45c7182-9207-4c3e-b8ba-f55e05c6c4ec}`
- Render: `喇叭 (Realtek(R) Audio)`, endpoint ID
  `{0.0.0.00000000}.{65382691-d1df-488d-8228-a312af984555}`
- Driver versions: unavailable in WASAPI diagnostics; Device Manager versions
  not yet supplied
- Listening route and observations (headphones/speakers, clicks/dropouts): not
  supplied

This is the user's chosen separate-endpoint setup (USB microphone to Realtek
output). It records useful evidence for that configuration; it does not
establish a same-interface duplex baseline.

## Negotiated settings

| Stream | Requested / actual rate | Requested / actual period | Buffer | Fallback |
| --- | --- | --- | --- | --- |
| Capture | 48,000 / 48,000 Hz | 480 / 480 frames (10 ms) | 1,056 frames | None |
| Render | 48,000 / 48,000 Hz | 480 / 480 frames (10 ms) | 1,056 frames | None |

## Final diagnostics

| Counter | Value |
| --- | ---: |
| Capture discontinuities | 2 total (initial output showed 1) |
| Capture overflows | 0 |
| Render failures | 0 |
| Device failed | false |
| Capture queue occupancy | 480 frames |

The counter increased by one from the initial output. The run duration and
audible result are unknown, so the additional discontinuity is not yet
characterized. Queue occupancy and requested periods are diagnostics; they do
not measure complete microphone-to-output latency.

## Remaining H01 evidence

- Confirm the run duration, whether wired headphones were connected, and any
  audible clicks/dropouts.
- Record the installed capture and render driver versions from Device Manager.
- Provide complete mic-to-output measurement evidence, or state the specific
  measurement limitation if no calibrated acoustic setup is available.

H01 remains partial pending those observations. Do not mark this run as a pass.
