# Windows session transfer (#101)

## Automated evidence

- `crates/native-audio-host/tests/session_transfer.rs` drives import and export
  through the public native transfer client and render-block seam. It verifies
  exact raw samples, stopped imported state, bounded writes, and that an
  incomplete canceled import leaves the live session Empty.
- `apps/windows/src/windows-session-files.test.tsx` exercises the Windows file
  adapter through the shared `@loopbeats/session-format` ZIP encoder/parser and
  verifies the acknowledged native chunk calls.
- The Web shell continues to use that same package; its import/export tests and
  package boundary checks remain the compatibility coverage.

## Windows transfer measurements

The Windows frontend writes a console measurement after a successful Save ZIP
or Load ZIP operation. Capture the object from WebView developer tools while
audio is running. It reports elapsed time, native invoke time (including IPC
serialization and native acknowledgement), format/archive or validation and
conversion time, sample and archive byte counts, maximum observed yield gap,
and a conservative temporary-memory estimate. The memory field is an estimate
from known buffers, not a process-memory measurement.

On the Windows x64 acceptance machine:

1. Run `npm run tauri:dev`, start audio, and create a completed Loop and a
   One-shot recording. Save ZIP while playback continues.
2. Load that ZIP and record progress, elapsed time and peak process memory.
   Confirm that both recordings return Stopped with their original settings.
3. Repeat with a different-rate session and record the conversion confirmation,
   duration, peak process memory and UI response while conversion/staging runs.
4. Cancel during chunk transfer and decline replacement after staging. Confirm
   that the prior live session remains intact in both cases.
5. Keep playback active and use the shared controls while transfer progress is
   visible. Record any missed interaction, stalled progress, or audio
   discontinuity separately from the file-operation measurements.

No Windows timing or process-memory measurements have been recorded in this
checkout. The automated evidence verifies transfer semantics, not Windows IPC
cost, process peak memory, or physical audio continuity. Record the machine,
Windows build, engine rate, source session size, measurements, and outcome when
the Windows run is performed; do not treat the logged estimate as measured
peak memory.
