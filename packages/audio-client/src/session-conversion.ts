import type { parseSession } from './session-import';
import { fitsImportMemory, SESSION_AUDIO_BYTES } from './session-limits';
import {
  defaultFx,
  maximumCutoff,
  type FxCutoffAdjustment,
} from './session-fx';
import type { FxConfig } from '@loopbeats/domain';

type Source = Awaited<ReturnType<typeof parseSession>>;
const PHASES = 1024;
const yieldTask = () =>
  new Promise<void>((resolve) => {
    // Message tasks yield to cancellation without nested-timer throttling.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
function rejected(): never {
  throw new Error(
    'Converted session exceeds supported length or memory limits. Your recordings are unchanged.',
  );
}

/** Preflight only. Coefficients and converted samples are computed lazily after consent. */
export function convertSession(
  source: Source,
  rate: number,
  check: () => void,
) {
  check();
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) rejected();
  const sourceRate = source.manifest.sampleRate;
  const fxAdjustments: FxCutoffAdjustment[] = [];
  const adjust = (config: FxConfig | undefined, scope: string): FxConfig => {
    // Version 1 has no saved cutoff: install target-rate defaults, not a cap warning.
    if (source.manifest.version === 1) return defaultFx(rate);
    if (!config) rejected();
    if (config.type === 'LowPass' && config.cutoffHz > maximumCutoff(rate)) {
      fxAdjustments.push({
        scope,
        previousHz: config.cutoffHz,
        cutoffHz: maximumCutoff(rate),
      });
      return { ...config, cutoffHz: maximumCutoff(rate) };
    }
    return { ...config };
  };
  const length = (frames: number) => {
    const numerator = frames * rate;
    const result = Math.floor(numerator / sourceRate + 0.5);
    if (
      !Number.isSafeInteger(numerator) ||
      !Number.isSafeInteger(result) ||
      result > rate * 60 ||
      (frames > 0 && result === 0)
    )
      rejected();
    return result;
  };
  const cycle = length(source.manifest.cycleLengthSamples);
  const manifest = {
    ...source.manifest,
    sampleRate: rate,
    inputFx: adjust(source.manifest.inputFx, 'Input'),
    cycleLengthSamples: cycle,
    tracks: source.manifest.tracks.map((t) => ({
      ...t,
      fx: adjust(t.fx, `Track ${t.id + 1}`),
      lengthSamples:
        t.lengthSamples && t.mode === 'Loop' ? cycle : length(t.lengthSamples),
    })),
    masterFx: adjust(source.manifest.masterFx, 'Master'),
  };
  const scales = manifest.tracks.map((t, id) =>
    Math.min(
      1,
      t.mode === 'Loop' && t.lengthSamples
        ? t.lengthSamples / source.manifest.tracks[id].lengthSamples
        : rate / sourceRate,
    ),
  );
  const radii = scales.map((scale) => Math.ceil(32 / scale));
  const maximumRadius = Math.max(...radii);
  const stride = 2 * maximumRadius + 1;
  const tableBytes = sourceRate === rate ? 0 : PHASES * stride * 8;
  if (
    maximumRadius > 1152 ||
    !fitsImportMemory(source.byteLength, rate, tableBytes + 32768) ||
    manifest.tracks.reduce((sum, t) => sum + t.lengthSamples * 4, 0) >
      SESSION_AUDIO_BYTES
  )
    rejected();
  let table: Float64Array | undefined;
  let cachedScale = 0;
  async function coefficients(id: number) {
    if (cachedScale === scales[id]) return;
    check();
    table ??= new Float64Array(PHASES * stride);
    const radius = radii[id],
      cutoff = 0.94 * scales[id];
    for (let phase = 0; phase < PHASES; phase++) {
      if (phase % 16 === 0) {
        check();
        await yieldTask();
      }
      const fraction = phase / PHASES;
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const d = offset - fraction;
        const x = cutoff * d;
        const weight =
          Math.abs(d) > radius
            ? 0
            : cutoff *
              (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) *
              (0.42 +
                0.5 * Math.cos((Math.PI * d) / radius) +
                0.08 * Math.cos((2 * Math.PI * d) / radius));
        table[phase * stride + offset + radius] = weight;
        sum += weight;
      }
      if (!Number.isFinite(sum) || Math.abs(sum) < 1e-12)
        throw new Error(
          'Sample-rate conversion failed. Try again. Your recordings are unchanged.',
        );
      for (let offset = 0; offset <= 2 * radius; offset++)
        table[phase * stride + offset] /= sum;
    }
    check();
    cachedScale = scales[id];
  }
  return {
    fxAdjustments,
    manifest,
    async read(
      id: number,
      offset: number,
      frames: number,
    ): Promise<Float32Array<ArrayBuffer>> {
      check();
      const track = manifest.tracks[id];
      if (
        !track ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(frames) ||
        frames < 1 ||
        frames > 2048 ||
        offset + frames > track.lengthSamples
      )
        rejected();
      if (sourceRate === rate) return source.read(id, offset, frames);
      await coefficients(id);
      const sample = source.recording(id),
        sourceLength = source.manifest.tracks[id].lengthSamples;
      const step =
        track.mode === 'Loop'
          ? sourceLength / track.lengthSamples
          : sourceRate / rate;
      const radius = radii[id],
        output = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        if (i % 256 === 0) {
          check();
          await yieldTask();
        }
        const position = (offset + i) * step;
        let base = Math.floor(position),
          phase = Math.floor((position - base) * PHASES + 0.5);
        if (phase === PHASES) {
          base++;
          phase = 0;
        }
        let value = 0;
        for (let tap = -radius; tap <= radius; tap++) {
          const at =
            track.mode === 'Loop'
              ? (((base + tap) % sourceLength) + sourceLength) % sourceLength
              : Math.max(0, Math.min(sourceLength - 1, base + tap));
          value += sample(at) * table![phase * stride + tap + radius];
        }
        output[i] = value;
        if (!Number.isFinite(output[i]))
          throw new Error(
            'Sample-rate conversion produced non-finite audio. Your recordings are unchanged.',
          );
      }
      check();
      return output;
    },
  };
}
