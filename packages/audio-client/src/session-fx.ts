import type { FxConfig } from '@loopbeats/domain';

export const maximumCutoff = (rate: number) => Math.min(20000, 0.45 * rate);
export const defaultFx = (rate: number): FxConfig => ({
  type: 'LowPass',
  cutoffHz: maximumCutoff(rate),
  bypassed: true,
});
export interface FxCutoffAdjustment {
  scope: string;
  previousHz: number;
  cutoffHz: number;
}

/** Reject duplicate JSON keys before JSON.parse can silently discard them. */
export function parseUniqueJson(source: string): unknown {
  const objects: (Set<string> | null)[] = [];
  const tokens =
    source.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(null);
    else if (token === '}' || token === ']') objects.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = objects.at(-1);
      const key = JSON.parse(token) as string;
      if (!keys || keys.has(key))
        throw new Error('Invalid duplicate session field.');
      keys.add(key);
    }
  }
  return JSON.parse(source) as unknown;
}

export function validFx(value: unknown, rate: number): value is FxConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  return (
    (v.type === 'None' && keys.length === 1) ||
    (v.type === 'LowPass' &&
      keys.length === 3 &&
      keys.every((k) => ['type', 'cutoffHz', 'bypassed'].includes(k)) &&
      typeof v.bypassed === 'boolean' &&
      typeof v.cutoffHz === 'number' &&
      Number.isFinite(v.cutoffHz) &&
      v.cutoffHz >= 20 &&
      v.cutoffHz <= maximumCutoff(rate))
  );
}
