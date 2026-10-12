# Independent Track filters — #80

Each track's playback/current raw overdub sum passes through its own fixed filter
before track gain and mute. Capture storage remains raw apart from Input FX;
Track processing never feeds back into recording. The mixer keeps float64
headroom through scope gains and the final output clamp.

Mute and zero volume gate output after DSP while position, history and bounded
parameter ramps keep advancing. Track STOP and CLEAR immediately clear only that
track's history and finish its accepted targets/removal. CLEAR retains its FX
configuration. New playback after Stopped/initial capture, and One-shot retrigger,
starts fresh. Loop wrap and unavailable PLAY on an already-playing Loop do not
reset history. Finishing overdub retains playback history. A One-shot's final
sample is filtered and mixed before its history is cleared; no tail follows it.

Inactive slots process silence without contributing output so editing/removing a
filter on an Empty/Stopped track can complete its bounded transition. Playback
still begins with fresh history at accepted targets.

The existing development preview gate adds Track 1/2 controls. Each scope has one
in-flight command and one latest queued target; UI displays acknowledged engine
configuration, pending/error state and bounded removal. Destructive and
interruption boundaries cancel queued edits. Ordinary production still exposes
no FX editor; ZIP/recovery integration and the public editor remain their own
tickets. Physical FX/load acceptance remains #83.

Verification uses independent known impulse/superposition values at the public
engine seam, mute/zero-volume reference signals, One-shot final samples,
Loop/history lifecycle and generation reuse, finite overrange samples,
allocation counting, and actual production-build worklet/WASM and touch controls.
