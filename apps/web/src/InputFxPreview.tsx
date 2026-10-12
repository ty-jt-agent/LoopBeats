import type { AudioSnapshot } from '@loopbeats/domain';
import type { AudioClient } from '@loopbeats/audio-client';

/** Build-gated tracer bullet; session persistence is required before public release. */
export function InputFxPreview({
  client,
  snapshot,
  enabled,
}: {
  client: AudioClient;
  snapshot: AudioSnapshot;
  enabled: boolean;
}) {
  const slot = snapshot.fx?.[0];
  const maximum = Math.min(20000, (snapshot.sampleRate ?? 48000) * 0.45);
  const config = slot?.config ?? {
    type: 'LowPass',
    cutoffHz: maximum,
    bypassed: true,
  };
  const editable = enabled && Boolean(slot) && !slot?.removing;
  const hasFilter = config.type === 'LowPass';
  const cutoff = hasFilter ? config.cutoffHz : maximum;
  const position = Math.round(
    (1000 * Math.log(cutoff / 20)) / Math.log(maximum / 20),
  );
  return (
    <section className="input-fx-preview" aria-labelledby="input-fx-heading">
      <h2 id="input-fx-heading">Input FX preview</h2>
      <p>
        Preview only: ZIP preserves FX; recovery does not yet preserve FX. Keep
        portable backups of recordings.
      </p>
      {!enabled && <p>Start or reinitialize audio before editing Input FX.</p>}
      <label>
        Input effect
        <select
          aria-label="Input effect"
          value={config.type}
          disabled={!editable || snapshot.inputFxPending}
          onChange={(event) =>
            client.setInputFx(
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
      <p>Input: {hasFilter ? (config.bypassed ? 'Bypassed' : 'On') : 'None'}</p>
      <button
        disabled={!editable || !hasFilter || snapshot.inputFxPending}
        onClick={() => hasFilter && client.setInputBypass(!config.bypassed)}
      >
        {hasFilter && !config.bypassed
          ? 'Bypass Input filter'
          : 'Enable Input filter'}
      </button>
      <label className="input-cutoff">
        Input cutoff
        <input
          aria-label="Input cutoff"
          type="range"
          min="0"
          max="1000"
          step="1"
          value={position}
          disabled={!editable || !hasFilter}
          onChange={(event) =>
            client.setInputCutoff(
              20 * (maximum / 20) ** (Number(event.target.value) / 1000),
            )
          }
        />
      </label>
      <output aria-label="Input cutoff value">
        {cutoff < 1000
          ? `${Math.round(cutoff)} Hz`
          : `${(cutoff / 1000).toFixed(2)} kHz`}
      </output>
      <p role="status">
        {!slot
          ? 'Input FX awaits audio initialization'
          : snapshot.inputFxPending
            ? 'Input FX command pending'
            : slot?.removing
              ? 'Removing Input filter'
              : slot?.transitioning
                ? 'Input FX target accepted; transitioning'
                : 'Input FX target acknowledged'}
      </p>
      {snapshot.inputFxError && <p role="alert">{snapshot.inputFxError}</p>}
    </section>
  );
}
