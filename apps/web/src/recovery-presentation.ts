import type { AudioClient } from '@loopbeats/audio-client';

type Recovery = ReturnType<AudioClient['getRecoverySnapshot']>;

/** Interpret existing client observations once; presentation never owns storage policy. */
export function recoveryPresentation(recovery: Recovery) {
  const checking = recovery.status.startsWith('Checking');
  const unavailable =
    recovery.available === false || recovery.status.includes('unavailable');
  const otherTab = !recovery.owner && recovery.status.includes('another tab');
  const readFailed = Boolean(
    recovery.error &&
    !unavailable &&
    (recovery.failureKind === 'initialization' || !recovery.failureKind),
  );
  let summary: string;
  if (checking) summary = 'Checking recovery.';
  else if (unavailable) summary = 'Recovery unavailable.';
  else if (otherTab) summary = 'Recovery paused: another tab owns recovery.';
  else if (recovery.error) {
    if (recovery.failureKind === 'saving')
      summary = 'Recovery could not be saved.';
    else if (recovery.failureKind === 'deletion')
      summary = 'Recovery copy could not be deleted.';
    else if (recovery.invalidRecord)
      summary = 'Saved workspace could not be read.';
    else if (recovery.failureKind === 'operation')
      summary = 'Recovery operation failed.';
    else summary = 'Recovery could not be checked.';
  } else if (recovery.offer) summary = 'Saved workspace available.';
  else if (recovery.status.startsWith('Saving')) summary = 'Saving recovery.';
  else if (recovery.status.startsWith('Changes'))
    summary = 'Recovery changes pending.';
  else if (recovery.savedAt !== null)
    summary = `Recovery saved. Saved at ${new Date(recovery.savedAt).toLocaleString()}.`;
  else
    summary = recovery.owner
      ? 'Recovery ready; no snapshot yet.'
      : 'Recovery paused.';
  return {
    summary,
    unavailable,
    otherTab,
    readFailed,
    canDiscard:
      !checking &&
      recovery.owner &&
      Boolean(recovery.offer || recovery.invalidRecord),
    canRetrySaving: Boolean(
      recovery.error &&
      recovery.failureKind === 'saving' &&
      recovery.owner &&
      !recovery.offer,
    ),
  };
}
