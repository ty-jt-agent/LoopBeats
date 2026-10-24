import type {
  FxScope,
  FxSnapshot,
  TrackId,
  TrackSnapshot,
} from '@loopbeats/domain';
import type { AudioApplicationCommand } from '@loopbeats/domain';
import { fxStateLabel } from './fx-state';
import { FxScopeLauncher } from './FxEditor';

type Props = {
  track: TrackSnapshot;
  trackId: TrackId;
  sampleRate: number | null;
  cycleLengthSamples: number;
  enabled: boolean;
  showFx: boolean;
  submit: (command: AudioApplicationCommand) => void;
  fx?: FxSnapshot;
  fxEditorScope: FxScope | null;
  onOpenFx: (scope: FxScope, trigger: HTMLButtonElement) => void;
  onClear: () => void;
  clearError?: string;
};

// Translate the current snapshot into an action, never into a new track state.
function primaryAction(track: TrackSnapshot) {
  if (track.state === 'Stopped')
    return {
      label: 'Play',
      command: 'play',
      available: track.canPlay,
    } as const;
  if (track.state === 'Playing' && track.mode === 'OneShot')
    return {
      label: 'Retrigger',
      command: 'play',
      available: track.canPlay,
    } as const;
  if (track.mode === 'OneShot' && track.state === 'Overdubbing') return null;
  const label = {
    Empty: 'Record',
    Recording: 'Finish recording',
    Playing: 'Overdub',
    Overdubbing: 'Finish overdub',
  }[track.state];
  return { label, command: 'record', available: track.canRecord } as const;
}

export function TrackStrip({
  track,
  trackId,
  sampleRate,
  cycleLengthSamples,
  enabled,
  showFx,
  submit,
  fx,
  fxEditorScope,
  onOpenFx,
  onClear,
  clearError,
}: Props) {
  const number = trackId + 1;
  const mode = track.mode === 'OneShot' ? 'One-shot' : 'Loop';
  const action = primaryAction(track);
  const recording = track.state === 'Recording';
  const captureProgress =
    recording && (track.mode === 'OneShot' || !cycleLengthSamples);
  const remaining = sampleRate
    ? (
        Math.max(0, track.captureLimitSamples - track.capturedSamples) /
        sampleRate
      ).toFixed(1)
    : '60.0';
  return (
    <section
      className="track-strip"
      data-state={track.state}
      aria-labelledby={`track-heading-${trackId}`}
    >
      <header className="track-header">
        <h2 id={`track-heading-${trackId}`}>
          Track {number} · {mode}
        </h2>
        <p className="track-state">
          <span data-testid="track-state">{track.state}</span>
          <span>FX {fxStateLabel(fx)}</span>
        </p>
      </header>
      <label className="mode-control">
        Playback mode
        <select
          aria-label={`Track ${number} playback mode`}
          value={track.mode}
          disabled={!enabled || !track.canSetMode}
          onChange={(event) =>
            submit({
              type: 'set-mode',
              trackId,
              mode:
                event.currentTarget.value === 'OneShot' ? 'OneShot' : 'Loop',
            })
          }
        >
          <option value="Loop" disabled={!track.canSetLoop}>
            Loop
          </option>
          <option value="OneShot">One-shot</option>
        </select>
      </label>
      {track.state === 'Stopped' && !track.canSetLoop && (
        <p className="restriction">
          Loop mode requires the recording to match the shared cycle length
          exactly.
        </p>
      )}
      <div className="track-performance">
        <label className="track-fader">
          Track volume
          <input
            type="range"
            aria-label={`Track ${number} volume`}
            min="0"
            max="1"
            step="0.01"
            value={track.gain}
            disabled={!enabled}
            onChange={(event) =>
              submit({
                type: 'set-track-gain',
                trackId,
                gain: Number(event.currentTarget.value),
              })
            }
          />
          <span>{Math.round(track.gain * 100)}%</span>
        </label>
        <div className="track-actions">
          <progress
            aria-label={`${mode} progress`}
            max={
              captureProgress
                ? track.captureLimitSamples || 1
                : (track.mode === 'Loop'
                    ? cycleLengthSamples
                    : track.lengthSamples) || 1
            }
            value={
              captureProgress ? track.capturedSamples : track.positionSamples
            }
          />
          <button
            className="primary-action"
            aria-label={`Track ${number} REC/PLAY — ${action?.label ?? 'Unavailable'}`}
            disabled={!enabled || !action?.available}
            onClick={() => {
              if (!enabled || !action?.available) return;
              submit({ type: action.command, trackId });
            }}
          >
            <span>REC/PLAY</span>
            <strong>{action?.label ?? 'Unavailable'}</strong>
          </button>
          <div className="track-buttons">
            <button
              disabled={!enabled || !track.canStop}
              onClick={() => submit({ type: 'stop-track', trackId })}
            >
              Track STOP
            </button>
            <button
              disabled={!enabled}
              aria-pressed={track.muted}
              onClick={() =>
                submit({ type: 'set-track-mute', trackId, muted: !track.muted })
              }
            >
              {track.muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
          <p className="mute-state">
            {track.muted ? 'Muted · position continues' : 'Not muted'}
          </p>
          {!enabled || !action?.available ? (
            <p className="restriction">
              {!enabled
                ? 'Audio must be ready; input switching must finish.'
                : 'Action unavailable: another capture or transport requirement may prevent it.'}
            </p>
          ) : null}
        </div>
      </div>
      <p className="capture-capacity">
        {track.mode === 'OneShot' || !cycleLengthSamples
          ? 'Recording limit: 60 seconds.'
          : 'Recording limit: one shared cycle.'}{' '}
        Remaining: <span data-testid="capture-remaining">{remaining} s</span>
      </p>
      {clearError && <p role="alert">{clearError}</p>}
      <details className="track-details">
        <summary>Track {number} details</summary>
        {showFx && (
          <FxScopeLauncher
            scope={(trackId + 1) as FxScope}
            slot={fx}
            selected={fxEditorScope === trackId + 1}
            onOpen={onOpenFx}
          />
        )}
        <details>
          <summary>Track {number} diagnostics</summary>
          <p>
            Captured samples:{' '}
            <span data-testid="captured-samples">{track.capturedSamples}</span>
          </p>
          <p>
            Loop samples:{' '}
            <span data-testid="loop-length">{track.lengthSamples}</span>
          </p>
        </details>
        <div className="destructive-controls">
          <p>
            Track STOP retains audio. CLEAR preserves the shared cycle. One-shot
            retriggers from the beginning; Loop playback joins the shared cycle.
          </p>
          <button
            disabled={!enabled || track.state === 'Empty'}
            onClick={onClear}
          >
            CLEAR
          </button>
        </div>
      </details>
    </section>
  );
}
