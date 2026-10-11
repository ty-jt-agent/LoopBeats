import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { AudioClient } from '@loopbeats/audio-client';
import { SessionExport } from './SessionExport';

test('canceling a pending export preserves the session and offers another attempt', async () => {
  const exportSession = vi.fn(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<Blob>((_, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error('Export canceled.')),
        );
      }),
  );
  render(
    <SessionExport
      client={{ exportSession } as unknown as AudioClient}
      enabled
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save ZIP' }));
  expect(screen.getByRole('button', { name: 'Save ZIP' })).toBeDisabled();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Cancel export' })),
  );
  expect(screen.getByRole('status')).toHaveTextContent('Export canceled.');
  expect(screen.getByRole('button', { name: 'Save ZIP' })).toBeEnabled();
});

test('export failure is actionable without downloading an archive', async () => {
  render(
    <SessionExport
      client={
        {
          exportSession: () =>
            Promise.reject(
              new Error('Recording changed during export. Try again.'),
            ),
        } as unknown as AudioClient
      }
      enabled
    />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save ZIP' })),
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Recording changed during export. Try again.',
  );
  expect(screen.getByRole('button', { name: 'Save ZIP' })).toBeEnabled();
});
