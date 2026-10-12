import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AudioClient, FxCutoffAdjustment } from '@loopbeats/audio-client';
import { RecoverySettings } from './RecoverySettings';
import { recoveryDeletionNotice } from './recovery-deletion-notice';
type Confirmation =
  | { kind: 'replace' }
  | { kind: 'discard' }
  | {
      kind: 'conversion';
      sourceRate: number;
      targetRate: number;
      fxAdjustments: readonly FxCutoffAdjustment[];
    };

export function SessionImport({
  client,
  enabled,
  disabledReason,
  onBusy,
  onStatus,
  onConfirmation,
  onRestoreFocus,
}: {
  client: AudioClient;
  enabled: boolean;
  disabledReason?: string;
  onBusy: (busy: boolean) => void;
  onStatus?: (status: string) => void;
  onConfirmation?: () => void;
  onRestoreFocus?: () => void;
}) {
  const operation = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState('');
  const [workflow, setWorkflow] = useState<'load' | 'recover' | 'discard'>(
    'load',
  );
  const [error, setError] = useState('');
  const recovery = useSyncExternalStore(
    client.subscribe,
    client.getRecoverySnapshot,
  );
  const [restoredPartial, setRestoredPartial] = useState<number | null>(null);
  const setLater = (deferred: boolean) => client.showRecoveryOffer(!deferred);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    onStatus?.(
      progress !== null
        ? committing
          ? workflow === 'discard'
            ? 'Deleting saved workspace...'
            : 'Finishing load…'
          : `${workflow === 'discard' ? 'Discarding saved workspace' : workflow === 'recover' ? 'Recovering session' : 'Loading session'}: ${Math.round(progress * 100)}%`
        : error || message,
    );
  }, [progress, committing, error, message, workflow, onStatus]);
  useEffect(() => {
    if (confirming) {
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (dialog.current?.open) {
      dialog.current.close();
      const trigger = confirmationTrigger.current;
      trigger?.focus();
      if (!trigger || document.activeElement !== trigger) onRestoreFocus?.();
    }
  }, [confirming, onRestoreFocus]);
  const start = async (file?: File, discard = false) => {
    const controller = new AbortController();
    confirmationTrigger.current = document.activeElement as HTMLElement | null;
    operation.current = controller;
    setWorkflow(discard ? 'discard' : file ? 'load' : 'recover');
    onBusy(true);
    setProgress(0);
    setCommitting(false);
    setError('');
    setMessage('');
    const confirm = (signal: AbortSignal, details: Confirmation) =>
      new Promise<boolean>((resolve) => {
        const finish = (confirmed: boolean) => {
          signal.removeEventListener('abort', abort);
          answer.current = null;
          setConfirming(null);
          resolve(confirmed);
        };
        const abort = () => finish(false);
        answer.current = finish;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) finish(false);
        else {
          onConfirmation?.();
          setConfirming(details);
        }
      });
    try {
      if (discard) {
        if (await confirm(controller.signal, { kind: 'discard' })) {
          setCommitting(true);
          await client.discardRecovery();
          setLater(false);
          setMessage('Recovery snapshot discarded.');
        }
        return;
      }
      const options = {
        signal: controller.signal,
        onProgress: setProgress,
        onCommitting: () => setCommitting(true),
        confirmReplace: (signal: AbortSignal) =>
          confirm(signal, { kind: 'replace' }),
        confirmConversion: (
          sourceRate: number,
          targetRate: number,
          signal: AbortSignal,
          fxAdjustments: readonly FxCutoffAdjustment[],
        ) =>
          confirm(signal, {
            kind: 'conversion',
            sourceRate,
            targetRate,
            fxAdjustments,
          }),
      };
      const imported = await (file
        ? client.importSession(file, options)
        : client.recoverSession(options));
      if (imported)
        setRestoredPartial(
          !file &&
            recovery.offer?.progress?.captureKinds.some((kind) => kind !== null)
            ? recovery.offer.progress.startedAt
            : null,
        );
      setMessage(
        imported
          ? file
            ? 'Session imported. Recordings are stopped; monitoring is off.'
            : 'Session recovered. Recordings are stopped; monitoring is off.'
          : 'Import canceled.',
      );
    } catch (failure) {
      if (controller.signal.aborted) setMessage('Import canceled.');
      else
        setError(
          failure instanceof Error
            ? failure.message
            : 'Import failed. Try again.',
        );
    } finally {
      answer.current?.(false);
      operation.current = null;
      setProgress(null);
      setCommitting(false);
      onBusy(false);
    }
  };
  return (
    <>
      <section aria-label="Session file loading">
        <h2 id="import-heading">Load ZIP</h2>
        <p>
          Load a saved session. If current recordings exist, you will confirm
          before replacing them. Imported recordings start stopped.
        </p>
        {disabledReason && <p>{disabledReason}</p>}
        <label>
          Load ZIP
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={!enabled || progress !== null}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void start(file);
            }}
          />
        </label>
        {progress !== null && (
          <>
            {committing && (
              <p role="status">
                {workflow === 'discard'
                  ? 'Deleting saved workspace...'
                  : 'Finishing load...'}
              </p>
            )}
            <progress
              aria-label="Session import progress"
              max="1"
              value={progress}
            />
            <button
              disabled={committing}
              onClick={() => operation.current?.abort()}
            >
              Cancel import
            </button>
          </>
        )}
        <dialog
          ref={dialog}
          aria-labelledby="import-confirm-heading"
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            answer.current?.(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.stopPropagation();
          }}
        >
          <h2 id="import-confirm-heading">
            {confirming?.kind === 'conversion'
              ? 'Convert sample rate?'
              : confirming?.kind === 'discard'
                ? 'Discard recovery snapshot?'
                : 'Replace current session?'}
          </h2>
          {confirming?.kind === 'conversion' ? (
            <p>
              Convert from {confirming.sourceRate.toLocaleString()} Hz to{' '}
              {confirming.targetRate.toLocaleString()} Hz? Conversion changes
              sample values and may affect fidelity. Lowering the sample rate
              loses high-frequency content. Your current session stays intact
              until replacement is confirmed.
              {confirming.fxAdjustments.map((adjustment) => (
                <span key={adjustment.scope}>
                  {' '}
                  {adjustment.scope} cutoff changes from {adjustment.previousHz}{' '}
                  Hz to {adjustment.cutoffHz} Hz after confirmation.
                </span>
              ))}
            </p>
          ) : confirming?.kind === 'discard' ? (
            <p>
              This deletes the browser recovery snapshot. Your current live
              recordings remain unchanged. Subsequent recovery saving can create
              a new copy.
            </p>
          ) : (
            <p>
              This replaces all current recordings and track settings. Imported
              recordings will be stopped.{' '}
              {workflow === 'recover'
                ? 'The saved recovery source is retained while recovery is validated and committed; subsequent saving protects the recovered workspace.'
                : recoveryDeletionNotice(recovery)}
            </p>
          )}
          {workflow === 'recover' &&
            recovery.offer?.progress?.captureKinds.some(
              (kind) => kind !== null,
            ) && (
              <p>
                Only partial recording or overdub audio through the saved
                checkpoint is restored. Capture never resumes; unsaved later
                audio is not included.
              </p>
            )}
          <button autoFocus onClick={() => answer.current?.(false)}>
            Cancel
          </button>
          <button onClick={() => answer.current?.(true)}>
            {confirming?.kind === 'conversion'
              ? 'Convert session'
              : confirming?.kind === 'discard'
                ? 'Discard snapshot'
                : 'Replace session'}
          </button>
        </dialog>
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
      <RecoverySettings
        recovery={recovery}
        enabled={enabled}
        busy={progress !== null}
        client={client}
        onRecover={() => void start()}
        onDiscard={() => void start(undefined, true)}
        restoredPartial={restoredPartial}
      />
    </>
  );
}
