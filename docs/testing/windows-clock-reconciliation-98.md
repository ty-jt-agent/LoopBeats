# Separate-endpoint clock reconciliation checkpoint (#98)

Status: implementation checkpoint, hardware evidence pending.

## Implemented approach

Render remains the engine clock. Capture samples are downmixed to mono and
written into a preallocated 16,384-frame FIFO. A render-owned linear resampler
converts the capture clock to the render rate. Once per render block, a bounded
proportional/integral controller uses FIFO occupancy to adjust the number of
capture frames consumed per output frame, limited to ±5000 ppm. Startup primes
the FIFO to one negotiated capture period plus two render periods converted to
capture frames. Playback-only stale recovery permits one additional normal
capture packet above that target before it drops a bounded batch of oldest
samples and reports a discontinuity. It never does this during initial
recording or overdub. Overflow and underflow remain reported as discontinuities
and preserve the existing active-capture interruption behavior. Resampling by
itself does not trigger interruption.

The controlled test seam verifies 48 kHz to 24 kHz conversion, correction
direction and correction bounds. A 10,000-block simulation with varied 64–480
frame render blocks, 96–480 frame capture packets, and a 1,000 ppm faster
capture producer keeps FIFO occupancy within 300 frames of its 1,000-frame
target without underflow or overflow. A separate controlled cadence test
delivers 480-frame capture packets against 128-frame render blocks and verifies
that normal packets trigger neither stale recovery nor underflow. These are
deterministic algorithm results; they do not establish controller stability on
physical devices.

## Physical evidence

No independently clocked capture/render pair, acoustic fixture, or Windows
WASAPI runtime was available in this implementation environment. Therefore no
physical buffer-occupancy/drift trace or microphone-to-output round-trip
observation is claimed, and the approach is not hardware-validated. The
checkpoint required by #98 remains open until the Windows hardware run records:

- capture/render endpoint identity, driver, negotiated rate, format, channels,
  period and buffer size;
- at least 60 minutes of per-second FIFO occupancy and correction data under
  representative Loop/overdub load, including discontinuities and dropouts;
- complete microphone-to-output observations from the calibrated fixture,
  with the measurement limitation recorded if the fixture cannot be used;
- whether occupancy remains bounded without sustained drift, the selected
  correction approach's observed range, and remaining uncertainty.

Run the matched-device baseline first, then the separate endpoint cases, and
finish with a confirmed independently clocked pair as specified in
[ADR-0009](../adr/0009-separate-capture-and-render-endpoints.md) and the
[Windows audio measurement procedure](../architecture/windows-native.md#owner-supplied-hardware-evidence).
