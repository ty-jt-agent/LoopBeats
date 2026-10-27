import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AudioApplication } from '@loopbeats/domain';
import {
  assembleSession,
  convertSession,
  parseSession,
  type ExportManifest,
  type SessionWork,
} from '@loopbeats/session-format';

type Props = {
  audio: AudioApplication;
  exportEnabled: boolean;
  importEnabled: boolean;
  onBusy: (busy: boolean) => void;
  onStatus: (status: string) => void;
};

type Confirmation = { title: string; message: string; accept: string };

/** Windows file adapter; encoding, validation and conversion stay in session-format. */
export function WindowsSessionFiles({
  audio,
  exportEnabled,
  importEnabled,
  onBusy,
  onStatus,
}: Props) {
  const operation = useRef<AbortController | null>(null);
  const answer = useRef<((accepted: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    onStatus(
      progress !== null
        ? `Session transfer: ${Math.round(progress * 100)}%`
        : error || message,
    );
  }, [error, message, onStatus, progress]);
  useEffect(() => {
    if (confirmation) {
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (dialog.current?.open) dialog.current.close();
  }, [confirmation]);

  const ask = (details: Confirmation, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      const finish = (accepted: boolean) => {
        signal.removeEventListener('abort', abort);
        answer.current = null;
        setConfirmation(null);
        resolve(accepted);
      };
      const abort = () => finish(false);
      answer.current = finish;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) finish(false);
      else setConfirmation(details);
    });

  const workFor = (
    controller: AbortController,
    noteGap: (gap: number) => void,
  ): SessionWork => ({
    checkCanceled() {
      if (controller.signal.aborted)
        throw new DOMException('Canceled', 'AbortError');
    },
    yieldToHost: () =>
      new Promise((resolve) => {
        const before = performance.now();
        setTimeout(() => {
          noteGap(performance.now() - before);
          resolve();
        }, 0);
      }),
  });

  const run = async (body: (controller: AbortController) => Promise<void>) => {
    const controller = new AbortController();
    operation.current = controller;
    onBusy(true);
    setProgress(0);
    setCommitting(false);
    setMessage('');
    setError('');
    try {
      await body(controller);
    } catch (failure) {
      if (controller.signal.aborted) setMessage('Session transfer canceled.');
      else
        setError(
          failure instanceof Error
            ? failure.message
            : 'Session transfer failed. Try again.',
        );
    } finally {
      answer.current?.(false);
      operation.current = null;
      setProgress(null);
      setCommitting(false);
      onBusy(false);
    }
  };

  const save = () =>
    run(async (controller) => {
      const started = performance.now();
      let maxYieldGapMs = 0;
      let nativeTransferMs = 0;
      const work = workFor(controller, (gap) => {
        maxYieldGapMs = Math.max(maxYieldGapMs, gap);
      });
      const begin = await invoke<{ token: number; manifest: ExportManifest }>(
        'audio_session_export_begin',
      );
      try {
        const blob = await assembleSession(
          begin.manifest,
          async (trackId, offset, frames) => {
            work.checkCanceled();
            const readStarted = performance.now();
            const samples = await invoke<number[]>(
              'audio_session_export_read',
              { token: begin.token, track: trackId, offset, frames },
            );
            nativeTransferMs += performance.now() - readStarted;
            if (samples.length !== frames)
              throw new Error('Incomplete recording transfer.');
            return new Float32Array(samples);
          },
          () => work.checkCanceled(),
          setProgress,
        );
        work.checkCanceled();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `loopbeats-session-${new Date().toISOString().replaceAll(':', '-')}.zip`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const sampleBytes = begin.manifest.tracks.reduce(
          (sum, track) => sum + track.lengthSamples * 4,
          0,
        );
        console.info('LoopBeats Windows session export measurement', {
          durationMs: performance.now() - started,
          nativeTransferMs,
          formatAndArchiveMs: Math.max(
            0,
            performance.now() - started - nativeTransferMs,
          ),
          sampleBytes,
          archiveBytes: blob.size,
          estimatedPeakTemporaryBytes: blob.size + sampleBytes + 32768,
          maximumYieldGapMs: maxYieldGapMs,
        });
        setMessage('ZIP download started.');
      } finally {
        await invoke('audio_session_export_end', { token: begin.token }).catch(
          () => undefined,
        );
      }
    });

  const load = (file: File) =>
    run(async (controller) => {
      let token: number | undefined;
      let maxYieldGapMs = 0;
      let nativeTransferMs = 0;
      const started = performance.now();
      const work = workFor(controller, (gap) => {
        maxYieldGapMs = Math.max(maxYieldGapMs, gap);
      });
      try {
        const targetRate = audio.getApplicationSnapshot().host.sampleRate;
        if (!targetRate)
          throw new Error('Windows audio sample rate is unavailable.');
        const source = await parseSession(
          await file.arrayBuffer(),
          targetRate,
          work,
          true,
        );
        work.checkCanceled();
        let session:
          ReturnType<typeof convertSession> | Awaited<typeof source> = source;
        if (source.manifest.sampleRate !== targetRate) {
          const converted = convertSession(source, targetRate, work);
          const adjustments = converted.fxAdjustments.length
            ? ` FX cutoffs will be adjusted: ${converted.fxAdjustments.map((item) => `${item.scope} ${item.previousHz} Hz to ${item.cutoffHz} Hz`).join(', ')}.`
            : '';
          const accepted = await ask(
            {
              title: 'Convert sample rate?',
              message: `Convert from ${source.manifest.sampleRate.toLocaleString()} Hz to ${targetRate.toLocaleString()} Hz? Conversion changes samples and may affect fidelity; lowering the rate loses high-frequency content.${adjustments}`,
              accept: 'Convert session',
            },
            controller.signal,
          );
          if (!accepted) {
            setMessage('Import canceled.');
            return;
          }
          session = converted;
        }
        work.checkCanceled();
        const importManifest = { ...session.manifest, version: 2 as const };
        const beginStarted = performance.now();
        token = await invoke<number>('audio_session_import_begin', {
          manifest: importManifest,
        });
        nativeTransferMs += performance.now() - beginStarted;
        const total = session.manifest.tracks.reduce(
          (sum, track) => sum + track.lengthSamples,
          0,
        );
        let written = 0;
        for (const track of session.manifest.tracks) {
          for (let offset = 0; offset < track.lengthSamples; offset += 2048) {
            work.checkCanceled();
            const frames = Math.min(2048, track.lengthSamples - offset);
            const samples = await session.read(track.id, offset, frames);
            const writeStarted = performance.now();
            await invoke('audio_session_import_write', {
              token,
              track: track.id,
              offset,
              samples: Array.from(samples),
            });
            nativeTransferMs += performance.now() - writeStarted;
            written += frames;
            setProgress(total ? written / total : 1);
            await work.yieldToHost();
          }
        }
        work.checkCanceled();
        const current = audio.getApplicationSnapshot().engine;
        if (current.tracks.some((track) => track.lengthSamples > 0)) {
          const accepted = await ask(
            {
              title: 'Replace current session?',
              message:
                'This replaces all current recordings and track settings. Imported recordings will start stopped.',
              accept: 'Replace session',
            },
            controller.signal,
          );
          if (!accepted) {
            setMessage('Import canceled.');
            return;
          }
        }
        work.checkCanceled();
        const commitStarted = performance.now();
        setCommitting(true);
        await invoke('audio_session_import_commit', { token });
        nativeTransferMs += performance.now() - commitStarted;
        token = undefined;
        console.info('LoopBeats Windows session import measurement', {
          durationMs: performance.now() - started,
          nativeTransferMs,
          validationAndConversionMs: Math.max(
            0,
            performance.now() - started - nativeTransferMs,
          ),
          archiveBytes: file.size,
          sampleBytes: total * 4,
          estimatedPeakTemporaryBytes: file.size + total * 4 + 32768,
          maximumYieldGapMs: maxYieldGapMs,
        });
        setMessage(
          'Session imported. Recordings are stopped; monitoring is off.',
        );
      } finally {
        if (token !== undefined) {
          await invoke('audio_session_cancel', { token }).catch(
            () => undefined,
          );
        }
      }
    });

  return (
    <section aria-label="Windows session files">
      <h2>Save ZIP</h2>
      <p>
        Save completed recordings and portable session settings. Device choices
        stay on this computer.
      </p>
      <button
        disabled={!exportEnabled || progress !== null}
        onClick={() => void save()}
      >
        Save ZIP
      </button>
      <h2>Load ZIP</h2>
      <p>
        Validate the complete session before staging it. Imported recordings
        start stopped.
      </p>
      <label>
        Load ZIP
        <input
          type="file"
          accept=".zip,application/zip"
          disabled={!importEnabled || progress !== null}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void load(file);
          }}
        />
      </label>
      {progress !== null && (
        <>
          {committing && <p role="status">Finishing session import…</p>}
          <progress
            aria-label="Windows session transfer progress"
            max="1"
            value={progress}
          />
          <button
            disabled={committing}
            onClick={() => operation.current?.abort()}
          >
            {committing ? 'Finishing import' : 'Cancel transfer'}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <dialog
        ref={dialog}
        aria-labelledby="windows-session-confirm-heading"
        onCancel={(event) => {
          event.preventDefault();
          answer.current?.(false);
        }}
      >
        <h2 id="windows-session-confirm-heading">{confirmation?.title}</h2>
        <p>{confirmation?.message}</p>
        <button autoFocus onClick={() => answer.current?.(false)}>
          Cancel
        </button>
        <button onClick={() => answer.current?.(true)}>
          {confirmation?.accept}
        </button>
      </dialog>
    </section>
  );
}
