import type { FxSnapshot } from '@loopbeats/domain';

export function fxStateLabel(slot?: FxSnapshot) {
  if (!slot) return 'Audio off';
  if (slot.removing) return 'Removing';
  if (slot.config.type === 'None') return 'None';
  return slot.config.bypassed ? 'Bypassed' : 'On';
}
