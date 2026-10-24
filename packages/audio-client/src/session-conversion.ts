import { convertSession as planConversion } from '@loopbeats/session-format';
import { messageSessionWork } from './session-work';

export function convertSession(
  source: Parameters<typeof planConversion>[0],
  rate: number,
  check: () => void,
) {
  return planConversion(source, rate, messageSessionWork(check));
}
