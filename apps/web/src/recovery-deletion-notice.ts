import type { AudioClient } from '@loopbeats/audio-client';

type Recovery = ReturnType<AudioClient['getRecoverySnapshot']>;

export function recoveryDeletionNotice(recovery: Recovery): string {
  return recovery.owner &&
    recovery.savingPaused === false &&
    recovery.available !== false
    ? "The current workspace's owned recovery copy is deleted first. Surviving recordings have no recovery copy until the next successful save."
    : "An unresolved previous workspace or another tab's recovery copy is retained.";
}
