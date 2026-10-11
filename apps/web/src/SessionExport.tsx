import { useEffect, useRef, useState } from 'react';
import type { AudioClient } from '@loopbeats/audio-client';

export function SessionExport({
  client,
  enabled,
  disabledReason,
  onBusy,
  onStatus,
}: {
  client: AudioClient;
  enabled: boolean;
  disabledReason?: string;
  onBusy?: (busy: boolean) => void;
  onStatus?: (status: string) => void;
}) {
  const operation = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    onStatus?.(
      progress !== null
        ? `Exporting session: ${Math.round(progress * 100)}%`
        : error || message,
    );
  }, [progress, error, message, onStatus]);
  const start = async () => {
    const controller = new AbortController();
    operation.current = controller;
    onBusy?.(true);
    setProgress(0);
    setError('');
    setMessage('');
    try {
      const blob = await client.exportSession({
        signal: controller.signal,
        onProgress: setProgress,
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `loopbeats-session-${new Date().toISOString().replaceAll(':', '-')}.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Release after the browser has consumed the click; not an audio timer.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('ZIP download started.');
    } catch (failure) {
      if (controller.signal.aborted) setMessage('Export canceled.');
      else
        setError(
          failure instanceof Error
            ? failure.message
            : 'Export failed. Try again.',
        );
    } finally {
      operation.current = null;
      setProgress(null);
      onBusy?.(false);
    }
  };
  return (
    <section aria-labelledby="export-heading">
      <h2 id="export-heading">Save ZIP</h2>
      <p>
        Download a portable session with all completed track recordings and
        session settings. An unfinished recording is not included.
      </p>
      {disabledReason && <p>{disabledReason}</p>}
      <button
        disabled={!enabled || progress !== null}
        onClick={() => {
          void start();
        }}
      >
        Save ZIP
      </button>
      {progress !== null && (
        <>
          <progress
            aria-label="Session export progress"
            max="1"
            value={progress}
          />
          <button onClick={() => operation.current?.abort()}>
            Cancel export
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
