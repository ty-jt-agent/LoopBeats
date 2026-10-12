import type { AudioSnapshot } from '@loopbeats/domain';
import type { AudioClient, PlaybackFxScope } from '@loopbeats/audio-client';

/** Development-only scoped controls; #82 owns the public performance editor. */
export function FxPreview({
  client,
  snapshot,
  enabled,
  scope,
  notice,
}: {
  client: AudioClient;
  snapshot: AudioSnapshot;
  enabled: boolean;
  scope: 0 | PlaybackFxScope;
  notice?: import('react').ReactNode;
}) {
  const label =
    scope === 0 ? 'Input' : scope === 3 ? 'Master' : `Track ${scope}`;
  const heading = `playback-fx-heading-${scope}`;
  const slot = snapshot.fx?.[scope];
  const maximum = Math.min(20000, (snapshot.sampleRate ?? 48000) * 0.45);
  const config = slot?.config ?? {
    type: 'LowPass',
    cutoffHz: maximum,
    bypassed: true,
  };
  const hasFilter = config.type === 'LowPass';
  const cutoff = hasFilter ? config.cutoffHz : maximum;
  const pending =
    scope === 0
      ? (snapshot.inputFxPending ?? false)
      : (snapshot.playbackFxPending?.[scope - 1] ?? false);
  const error =
    scope === 0
      ? snapshot.inputFxError
      : snapshot.playbackFxErrors?.[scope - 1];
  const setConfig = (config: import('@loopbeats/domain').FxConfig) =>
    scope === 0
      ? client.setInputFx(config)
      : client.setPlaybackFx(scope, config);
  const setCutoff = (cutoff: number) =>
    scope === 0
      ? client.setInputCutoff(cutoff)
      : client.setPlaybackCutoff(scope, cutoff);
  const setBypass = (bypassed: boolean) =>
    scope === 0
      ? client.setInputBypass(bypassed)
      : client.setPlaybackBypass(scope, bypassed);
  const editable = enabled && Boolean(slot) && !slot?.removing;
  const position = Math.round(
    (1000 * Math.log(cutoff / 20)) / Math.log(maximum / 20),
  );
  return (
    <section className="input-fx-preview" aria-labelledby={heading}>
      <h2 id={heading}>{label} FX preview</h2>
      {notice ?? (
        <p>
          Preview only: use portable recordings as backups. Session FX
          persistence is required before public release.
        </p>
      )}
      <label>
        {label} effect
        <select
          aria-label={`${label} effect`}
          value={config.type}
          disabled={!editable || pending}
          onChange={(event) =>
            setConfig(
              event.target.value === 'None'
                ? { type: 'None' }
                : { type: 'LowPass', cutoffHz: maximum, bypassed: true },
            )
          }
        >
          <option value="None">None</option>
          <option value="LowPass">Low-pass</option>
        </select>
      </label>
      <p>
        {label}: {hasFilter ? (config.bypassed ? 'Bypassed' : 'On') : 'None'}
      </p>
      <button
        disabled={!editable || !hasFilter || pending}
        onClick={() => hasFilter && setBypass(!config.bypassed)}
      >
        {hasFilter && !config.bypassed
          ? `Bypass ${label} filter`
          : `Enable ${label} filter`}
      </button>
      <label className="input-cutoff">
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
              20 * (maximum / 20) ** (Number(event.target.value) / 1000),
            )
          }
        />
      </label>
      <output aria-label={`${label} cutoff value`}>
        {cutoff < 1000
          ? `${Math.round(cutoff)} Hz`
          : `${(cutoff / 1000).toFixed(2)} kHz`}
      </output>
      <p role="status">
        {!slot
          ? `${label} FX awaits audio initialization`
          : pending
            ? `${label} FX command pending`
            : slot.removing
              ? `Removing ${label} filter`
              : slot.transitioning
                ? `${label} FX target accepted; transitioning`
                : `${label} FX target acknowledged`}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
