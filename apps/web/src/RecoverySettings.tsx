import type { AudioClient } from '@loopbeats/audio-client';

type Recovery = ReturnType<AudioClient['getRecoverySnapshot']>;

export function RecoverySettings({
  client,
  recovery,
  enabled,
  busy,
  onRecover,
  onDiscard,
}: {
  client: AudioClient;
  recovery: Recovery;
  enabled: boolean;
  busy: boolean;
  onRecover: () => void;
  onDiscard: () => void;
}) {
  const later = !recovery.offerVisible;
  return (
    <section aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Session recovery</h2>
      <p data-testid="recovery-status">{recovery.status}</p>
      {recovery.savedAt !== null && (
        <p>
          Last successful snapshot:{' '}
          {new Date(recovery.savedAt).toLocaleString()}.
        </p>
      )}
      <p>
        Recordings and overdubs are checkpointed every five seconds while
        active. Saved audio represents the checkpoint start, not the later save
        time. Delays or crashes may lose newer changes; browser storage may be
        cleared. Export a session ZIP for a portable backup.
      </p>
      <p>
        CLEAR, replacement and global STOP during initial recording remove the
        previous recovery snapshot first. Remaining recordings are protected
        again after the next successful save.
      </p>
      {recovery.offer && !later && (
        <>
          {recovery.offer.progress?.captureKinds.some(
            (kind) => kind !== null,
          ) && (
            <p>
              Recovery contains partial recording or overdub audio frozen at{' '}
              {new Date(recovery.offer.progress.startedAt).toLocaleString()}.
              Recorded tracks open stopped; capture never resumes.
            </p>
          )}
          <button onClick={() => client.showRecoveryOffer(false)}>Later</button>
          <button
            disabled={!enabled || busy || !recovery.owner}
            onClick={onRecover}
          >
            Recover session
          </button>
          <p>
            Start audio to recover. Conversion and replacement require
            confirmation when needed.
          </p>
        </>
      )}
      {recovery.offer && later && (
        <button onClick={() => client.showRecoveryOffer(true)}>
          Show recovery offer
        </button>
      )}
      {(recovery.offer || recovery.error) && recovery.owner && (
        <button disabled={busy} onClick={onDiscard}>
          Discard recovery
        </button>
      )}
      {recovery.owner && !recovery.offer && (
        <button onClick={() => client.retryRecoverySaving()}>
          Retry saving
        </button>
      )}
      {!recovery.owner && (
        <button onClick={() => void client.retryRecoveryOwnership()}>
          Retry recovery ownership
        </button>
      )}
      {recovery.error && (
        <p role="alert">
          {recovery.error} Last successful snapshot is retained unless
          explicitly discarded.
        </p>
      )}
    </section>
  );
}
