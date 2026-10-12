# Portable session FX — #78

Portable saves now write archive version 2. Input and Master configuration live at
the root; each ordered track contains its own `fx`, including Empty tracks and
unfinished recordings omitted from a manual export. WAVs remain the raw mono
float32 recordings. Track/Master processing is never rendered into these WAVs.

Readers validate v1 and v2 before staging. Legacy v1 restores default bypassed
filters; v2 requires all four exact slot shapes. Unknown versions/types, missing
or unexpected fields, duplicate JSON keys, non-finite numbers and source-rate
cutoffs outside the supported range reject the entire operation. Bypass does not
relax validation. No automatic downgrade or invalid-file clamping is offered.

Conversion preserves Hz when supported by the target rate. The existing consent
dialog lists every affected scope and its old/new cutoff before a source-valid
cutoff is capped. Cancellation preserves the live session. A valid live Input FX
edit invalidates the existing revision-guarded import transaction.

The engine stages audio and configuration in the existing reserved bank and
commits them together. Restored tracks are Stopped/Empty, transport is zero,
monitoring is off, and all histories and ramps start fresh at accepted targets.
Manual export freezes accepted configuration at the audio metadata boundary,
including `None` during removal; it never serializes transient DSP state.

Recovery archive creation remains v1 until #79 adds consistent configuration
capture and dirty tracking. The reader already supports both contained archive
versions. The development-only FX preview remains gated until #82; it now states
that ZIP preserves FX while recovery does not yet preserve it.

Verification covers independent Python ZIP fixtures, strict scoped validation,
public engine atomicity/fresh-impulse/revision tests, conversion planning and
actual production-build Save/Load controls with the real worklet/WASM path.
Physical FX/audio load acceptance remains deferred to #83.
