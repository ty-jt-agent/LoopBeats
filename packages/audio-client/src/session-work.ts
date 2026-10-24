import type { SessionWork } from '@loopbeats/session-format';

export function timerSessionWork(checkCanceled: () => void): SessionWork {
  return {
    checkCanceled,
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

export function messageSessionWork(checkCanceled: () => void): SessionWork {
  return {
    checkCanceled,
    yieldToHost: () =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(null);
      }),
  };
}
