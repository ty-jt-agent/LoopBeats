import type { AudioClient } from '@loopbeats/audio-client';

type Recovery = ReturnType<AudioClient['getRecoverySnapshot']>;

import { recoveryPresentation } from './recovery-presentation';

export function RecoverySettings({
  recovery,
  enabled,
  busy,
  onRecover,
  onDiscard,
  client,
  restoredPartial,
}: {
  recovery: Recovery;
  enabled: boolean;
  busy: boolean;
  onRecover: () => void;
  onDiscard: () => void;
  client: AudioClient;
  restoredPartial: number | null;
}) {
  const {
    summary,
    unavailable,
    otherTab,
    readFailed,
    canDiscard,
    canRetrySaving,
  } = recoveryPresentation(recovery);
  const partial = recovery.offer?.progress?.captureKinds.some(
    (kind) => kind !== null,
  )
    ? recovery.offer.progress.startedAt
    : restoredPartial;
  return (
    <section aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Recovery</h2>
      <p data-testid="recovery-status" role="status">
        {summary}
      </p>
      {recovery.savedAt !== null && !recovery.status.startsWith('Saved at') && (
        <p>
          Last successful snapshot:{' '}
          {new Date(recovery.savedAt).toLocaleString()}.
        </p>
      )}
      {recovery.error && <p role="alert">{recovery.error}</p>}
      {unavailable && (
        <p>
          Use Save ZIP for a portable backup when available. Reload to check
          browser recovery availability again.
        </p>
      )}
      {readFailed && (
        <p>
          Current recovery saving is paused. Use Save ZIP when available, then
          reload to check recovery again.
        </p>
      )}
      {recovery.offer && (
        <>
          <p>
            The saved workspace is kept. Saving the current workspace is paused
            until you recover or discard it.
          </p>
          {partial !== null && partial !== undefined && (
            <p>
              Recovery contains partial recording or overdub audio frozen at{' '}
              {new Date(partial).toLocaleString()}. Only the saved prefix is
              restored; capture never resumes.
            </p>
          )}
          {recovery.offerVisible ? (
            <>
              <button
                disabled={!enabled || busy || !recovery.owner}
                onClick={onRecover}
              >
                Recover
              </button>
              <button onClick={() => client.showRecoveryOffer(false)}>
                Later
              </button>
              {!enabled && (
                <p>
                  Recover uses the same availability as Load ZIP. Start audio
                  and finish any capture or input change first.
                </p>
              )}
            </>
          ) : (
            <button onClick={() => client.showRecoveryOffer(true)}>
              Show recovery offer
            </button>
          )}
        </>
      )}
      {canDiscard && (
        <button disabled={busy} onClick={onDiscard}>
          Discard saved workspace
        </button>
      )}
      {canRetrySaving && (
        <button disabled={busy} onClick={() => client.retryRecoverySaving()}>
          Retry saving
        </button>
      )}
      {otherTab && (
        <>
          <p>
            The owning tab keeps its recovery copy. Retrying does not take
            ownership from an active tab.
          </p>
          <button
            disabled={busy}
            onClick={() => void client.retryRecoveryOwnership()}
          >
            Retry ownership
          </button>
        </>
      )}
      <details>
        <summary>Recovery details</summary>
        {recovery.savedAt !== null && (
          <p>
            Last successful snapshot:{' '}
            {new Date(recovery.savedAt).toLocaleString()}. A failed save retains
            this copy.
          </p>
        )}
        {recovery.frozenAt != null && (
          <p>
            Saved audio is frozen at{' '}
            {new Date(recovery.frozenAt).toLocaleString()}, before the save
            completed.
          </p>
        )}
        {restoredPartial !== null && (
          <p>
            Recovered partial recording or overdub audio is frozen at{' '}
            {new Date(restoredPartial).toLocaleString()}. Only the saved prefix
            was restored; tracks are stopped and capture never resumes.
          </p>
        )}
        <p>
          Recovery is local to this browser. Active recordings and overdubs are
          checkpointed about every five seconds. Delays, crashes or cleared
          browser storage may lose newer changes; no maximum loss interval is
          guaranteed. Save ZIP provides a portable copy of completed recordings.
        </p>
        <p>
          CLEAR, replacement and global STOP during initial recording can delete
          the owned current checkpoint first. Surviving recordings have no
          recovery copy until the next successful save. An unresolved previous
          workspace or another tab's copy is retained.
        </p>
      </details>
    </section>
  );
}
