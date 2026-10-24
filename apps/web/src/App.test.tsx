import { render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { AudioClient } from '@loopbeats/audio-client';
import { App } from './App';

const snapshot = {
  status: 'idle',
  monitoring: false,
  error: null,
  sampleRate: null,
  processedFrames: 0,
  inputLevel: 0,
  outputLevel: 0,
  masterGain: 1,
  inputDeviceId: null,
  transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
  tracks: [0, 1].map(() => ({
    mode: 'Loop',
    state: 'Empty',
    gain: 1,
    muted: false,
    canSetMode: false,
    canSetLoop: false,
    canRecord: false,
    canPlay: false,
    canStop: false,
    capacitySamples: 2880000,
    captureLimitSamples: 2880000,
    capturedSamples: 0,
    lengthSamples: 0,
    positionSamples: 0,
  })),
};
const recoverySnapshot = {
  status: 'Recovery disabled.',
  owner: false,
  offer: null,
  savedAt: null,
  error: null,
  offerVisible: true,
};
const client = {
  getSnapshot: () => snapshot,
  getRecoverySnapshot: () => recoverySnapshot,
  subscribe: () => () => {},
  enableRecovery: () => () => {},
  stop: vi.fn(),
  setMasterGain: vi.fn(),
  setTrackGain: vi.fn(),
  setTrackMute: vi.fn(),
  setMode: vi.fn(),
} as unknown as AudioClient;

test('opens a clearly identified loopstation shell without claiming recordings exist', () => {
  render(<App client={client} />);
  expect(
    screen.getByRole('heading', { name: 'LoopBeats', level: 1 }),
  ).toBeVisible();
  for (const name of ['Track 1 · Loop', 'Track 2 · Loop']) {
    const track = within(screen.getByRole('region', { name }));
    expect(track.getByTestId('track-state')).toHaveTextContent('Empty');
    expect(track.getByRole('button', { name: /REC\/PLAY/ })).toBeDisabled();
  }
});
