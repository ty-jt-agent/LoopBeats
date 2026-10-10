import { useEffect, useRef, useState } from 'react';
import type { AudioClient } from '@loopbeats/audio-client';

export function SessionExport({
  client,
  enabled,
  onBusy,
  onStatus,
}: {
  client: AudioClient;
  enabled: boolean;
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
      setMessage('Session ZIP downloaded.');
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
      <h2 id="export-heading">Session export</h2>
      <p>
        Export completed recordings and track settings as a ZIP. Unfinished
        recordings are excluded. Finish overdub before exporting.
      </p>
      <button
        disabled={!enabled || progress !== null}
        onClick={() => {
          void start();
        }}
      >
        Export session
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
