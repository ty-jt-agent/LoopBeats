import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { FxConfig, FxScope, FxSnapshot } from '@loopbeats/domain';
import type { AudioSnapshot } from '@loopbeats/domain';
import { fxStateLabel } from './fx-state';

const scopes: readonly { id: FxScope; name: string }[] = [
  { id: 0, name: 'Input' },
  { id: 1, name: 'Track 1' },
  { id: 2, name: 'Track 2' },
  { id: 3, name: 'Master' },
];

function fxScopeName(scope: FxScope) {
  return scopes[scope].name;
}

export function FxScopeLauncher({
  scope,
  slot,
  selected,
  onOpen,
}: {
  scope: FxScope;
  slot?: FxSnapshot;
  selected: boolean;
  onOpen: (scope: FxScope, trigger: HTMLButtonElement) => void;
}) {
  const name = fxScopeName(scope);
  return (
    <button
      className="fx-scope-launcher"
      type="button"
      aria-label={`Open ${name} effects`}
      aria-expanded={selected}
      aria-controls="fx-editor"
      onClick={(event) => onOpen(scope, event.currentTarget)}
    >
      {name} FX · {fxStateLabel(slot)}
    </button>
  );
}

function formatCutoff(cutoffHz: number) {
  return cutoffHz < 1000
    ? `${Math.round(cutoffHz)} Hz`
    : `${(cutoffHz / 1000).toFixed(2)} kHz`;
}

export function FxEditor({
  onConfigChange,
  supportedScopes,
  snapshot,
  enabled,
  scope,
  intentResetKey,
  focusRequest,
  onScopeChange,
  onClose,
}: {
  onConfigChange: (scope: FxScope, config: FxConfig) => void;
  supportedScopes: readonly FxScope[];
  snapshot: AudioSnapshot;
  enabled: boolean;
  scope: FxScope;
  intentResetKey: number;
  focusRequest: number;
  onScopeChange: (scope: FxScope) => void;
  onClose: () => void;
}) {
  const scopeSelector = useRef<HTMLSelectElement>(null);
  useLayoutEffect(() => {
    scopeSelector.current?.focus();
  }, [focusRequest]);
  const label = fxScopeName(scope);
  const heading = `fx-editor-heading-${scope}`;
  const slot = snapshot.fx?.[scope];
  const maximum = Math.min(20000, (snapshot.sampleRate ?? 48000) * 0.45);
  const playbackIndex = scope - 1;
  const pending =
    scope === 0
      ? (snapshot.inputFxPending ?? false)
      : (snapshot.playbackFxPending?.[playbackIndex] ?? false);
  const error =
    scope === 0
      ? snapshot.inputFxError
      : scope === 3
        ? (snapshot.masterFxError ?? snapshot.playbackFxErrors?.[2])
        : snapshot.playbackFxErrors?.[playbackIndex];
  const defaultConfig = useMemo<FxConfig>(
    () => ({ type: 'LowPass', cutoffHz: maximum, bypassed: true }),
    [maximum],
  );
  const acknowledgedConfig = slot?.config ?? defaultConfig;
  const desiredConfigs = useRef(new Map<FxScope, FxConfig>());
  useLayoutEffect(() => {
    desiredConfigs.current.clear();
  }, [intentResetKey]);
  useEffect(() => {
    const desired = desiredConfigs.current.get(scope);
    if (
      desired &&
      !pending &&
      (error || JSON.stringify(desired) === JSON.stringify(acknowledgedConfig))
    )
      desiredConfigs.current.delete(scope);
  }, [acknowledgedConfig, error, pending, scope]);
  const config = acknowledgedConfig;
  const requestConfig = (next: FxConfig) => {
    desiredConfigs.current.set(scope, next);
    onConfigChange(scope, next);
  };
  const hasFilter = config.type === 'LowPass';
  const cutoff = hasFilter ? config.cutoffHz : maximum;
  const editable = enabled && Boolean(slot) && !slot?.removing;
  const position = Math.round(
    (1000 * Math.log(cutoff / 20)) / Math.log(maximum / 20),
  );
  const setCutoff = (next: number) => {
    const bounded = Math.max(20, Math.min(maximum, next));
    const current = desiredConfigs.current.get(scope) ?? config;
    if (current.type === 'LowPass')
      requestConfig({ ...current, cutoffHz: bounded });
  };
  const toggleBypass = () => {
    const current = desiredConfigs.current.get(scope) ?? config;
    if (current.type === 'LowPass')
      requestConfig({ ...current, bypassed: !current.bypassed });
  };
  const acknowledgedState =
    acknowledgedConfig.type === 'None'
      ? 'None'
      : acknowledgedConfig.bypassed
        ? 'Bypassed'
        : 'On';

  return (
    <section
      id="fx-editor"
      className="fx-editor"
      role="region"
      aria-labelledby={heading}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="fx-editor-header">
        <h2 id={heading}>{label} effects</h2>
        <button type="button" onClick={onClose}>
          Close effects
        </button>
      </header>
      <label className="fx-scope-select">
        Editing scope
        <select
          ref={scopeSelector}
          aria-label="Effect scope"
          value={scope}
          onChange={(event) =>
            onScopeChange(Number(event.currentTarget.value) as FxScope)
          }
        >
          {scopes.map((option) => (
            <option
              key={option.id}
              value={option.id}
              disabled={!supportedScopes.includes(option.id)}
            >
              {option.name}
            </option>
          ))}
        </select>
      </label>
      <div className="fx-editor-controls">
        <label>
          {label} effect
          <select
            aria-label={`${label} effect`}
            value={config.type}
            disabled={!editable || pending}
            onChange={(event) =>
              requestConfig(
                event.currentTarget.value === 'None'
                  ? { type: 'None' }
                  : { type: 'LowPass', cutoffHz: maximum, bypassed: true },
              )
            }
          >
            <option value="None">None</option>
            <option value="LowPass">Low-pass</option>
          </select>
        </label>
        <button
          type="button"
          className="fx-toggle"
          aria-label={
            hasFilter && !config.bypassed
              ? `Bypass ${label} filter`
              : `Enable ${label} filter`
          }
          aria-pressed={hasFilter && !config.bypassed}
          disabled={!editable || !hasFilter || pending}
          onClick={() => hasFilter && toggleBypass()}
        >
          {hasFilter && !config.bypassed ? 'Bypass' : 'On'}
        </button>
        <label className="fx-cutoff">
          {label} cutoff
          <input
            aria-label={`${label} cutoff`}
            type="range"
            min="0"
            max="1000"
            step="1"
            value={position}
            disabled={!editable || !hasFilter}
            onChange={(event) =>
              setCutoff(
                20 *
                  (maximum / 20) ** (Number(event.currentTarget.value) / 1000),
              )
            }
          />
        </label>
        <div className="fx-cutoff-adjusters" aria-label="Cutoff adjustment">
          <button
            type="button"
            aria-label={`Lower ${label} cutoff by 1/12 octave`}
            disabled={!editable || !hasFilter}
            onClick={() => setCutoff(cutoff / 2 ** (1 / 12))}
          >
            −
          </button>
          <output aria-label={`${label} cutoff value`}>
            {formatCutoff(cutoff)}
          </output>
          <button
            type="button"
            aria-label={`Raise ${label} cutoff by 1/12 octave`}
            disabled={!editable || !hasFilter}
            onClick={() => setCutoff(cutoff * 2 ** (1 / 12))}
          >
            +
          </button>
        </div>
      </div>
      <p className="fx-acknowledged" data-testid="fx-acknowledged">
        {label}: {acknowledgedState}
      </p>
      <p>Engine-acknowledged cutoff: {formatCutoff(cutoff)}</p>
      <p role="status" aria-live="polite">
        {!slot
          ? 'Start audio to edit effects.'
          : slot.removing
            ? `Removing the ${label} filter. Wait for removal to finish.`
            : pending
              ? `A ${label} FX command is pending. Shown settings are the last engine-acknowledged target.`
              : slot.transitioning
                ? `${label} target accepted; the filter is transitioning. Its instantaneous DSP value is not shown.`
                : `${label} FX target acknowledged.`}
      </p>
      {!enabled && slot && (
        <p className="fx-disabled-reason">
          {snapshot.status !== 'ready'
            ? 'Audio must be ready before you can edit effects.'
            : 'Wait for input switching to finish before editing effects.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <details className="fx-explanation">
        <summary>About effects</summary>
        <p>
          Input effects shape new capture and overdub additions. Track effects
          shape playback for one track. Master effects shape the combined
          output. Track and Master effects do not change stored recordings.
          Bypassed filters keep their settings and sound history; removal
          returns the scope to None.
        </p>
      </details>
    </section>
  );
}
