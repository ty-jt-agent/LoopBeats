import { parseSession as parseArchive } from '@loopbeats/session-format';
import { timerSessionWork } from './session-work';

export function parseSession(
  buffer: ArrayBuffer,
  rate: number,
  check: () => void = () => {},
  allowDifferentRate = false,
) {
  return parseArchive(
    buffer,
    rate,
    timerSessionWork(check),
    allowDifferentRate,
  );
}
