import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AudioSnapshot, TrackSnapshot } from '@loopbeats/domain';
import { App } from './App';

const host = vi.hoisted(() => ({
  snapshot: null as unknown as AudioSnapshot,
  listeners: new Set<() => void>(),
  record: vi.fn(),
  play: vi.fn(),
  switchInput: vi.fn(),
  stopTransport: vi.fn(),
  startTracks: vi.fn(),
  recovery: {
    status: 'Recovery disabled.',
    owner: false,
    offer: null,
    savedAt: null,
    error: null,
    offerVisible: true,
  },
}));
vi.mock('@loopbeats/audio-client', () => ({
  AudioClient: class {
    getSnapshot = () => host.snapshot;
    getRecoverySnapshot = () => host.recovery;
    enableRecovery = () => () => {};
    subscribe = (listener: () => void) => {
      host.listeners.add(listener);
      return () => host.listeners.delete(listener);
    };
    record = host.record;
    play = host.play;
    switchInput = host.switchInput;
    stopTransport = host.stopTransport;
    startTracks = host.startTracks;
    stop = vi.fn();
    setMasterGain = vi.fn();
    setTrackGain = vi.fn();
    setTrackMute = vi.fn();
    setMode = vi.fn();
  },
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.clearAllMocks();
  const empty: TrackSnapshot = {
    mode: 'Loop',
    state: 'Empty',
    gain: 1,
    muted: false,
    canSetMode: true,
    canSetLoop: true,
    canRecord: true,
    canPlay: false,
    canStop: false,
    capacitySamples: 2880000,
    captureLimitSamples: 2880000,
    capturedSamples: 0,
    lengthSamples: 0,
    positionSamples: 0,
  };
  host.snapshot = {
    status: 'ready',
    monitoring: false,
    error: null,
    sampleRate: 48000,
    processedFrames: 0,
    inputLevel: 0,
    outputLevel: 0,
    masterGain: 1,
    inputDeviceId: null,
    transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
    tracks: [empty, { ...empty }],
  };
});

test.each([
  ['Loop', 'Empty', 'Record', 'record'],
  ['Loop', 'Recording', 'Finish recording', 'record'],
  ['Loop', 'Playing', 'Overdub', 'record'],
  ['Loop', 'Overdubbing', 'Finish overdub', 'record'],
  ['Loop', 'Stopped', 'Play', 'play'],
  ['OneShot', 'Empty', 'Record', 'record'],
  ['OneShot', 'Recording', 'Finish recording', 'record'],
  ['OneShot', 'Stopped', 'Play', 'play'],
  ['OneShot', 'Playing', 'Retrigger', 'play'],
] as const)(
  '%s %s offers %s through the combined control',
  (mode, state, label, command) => {
    host.snapshot = {
      ...host.snapshot,
      tracks: [
        {
          ...host.snapshot.tracks[0],
          mode,
          state,
          canRecord: true,
          canPlay: true,
          muted: true,
        },
        host.snapshot.tracks[1],
      ],
    };
    render(<App />);
    fireEvent.click(
      screen.getByRole('button', { name: `Track 1 REC/PLAY — ${label}` }),
    );
    expect(host[command]).toHaveBeenCalledWith(0);
    expect(host[command === 'play' ? 'record' : 'play']).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('track-state')[0]).toHaveTextContent(state);
  },
);

test.each([
  'idle',
  'starting',
  'interrupted',
  'recovering',
  'stopping',
  'error',
] as const)('%s audio cannot send a primary command', (status) => {
  host.snapshot = { ...host.snapshot, status };
  render(<App />);
  const button = screen.getByRole('button', {
    name: 'Track 1 REC/PLAY — Record',
  });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(host.record).not.toHaveBeenCalled();
  expect(host.play).not.toHaveBeenCalled();
});

test.each([
  ['Playing', false, true, 'Overdub'],
  ['Stopped', true, false, 'Play'],
] as const)(
  'unavailable %s action never falls back to another command',
  (state, canRecord, canPlay, label) => {
    host.snapshot = {
      ...host.snapshot,
      tracks: [
        { ...host.snapshot.tracks[0], state, canRecord, canPlay },
        host.snapshot.tracks[1],
      ],
    };
    render(<App />);
    const button = screen.getByRole('button', {
      name: `Track 1 REC/PLAY — ${label}`,
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(host.record).not.toHaveBeenCalled();
    expect(host.play).not.toHaveBeenCalled();
  },
);

test('a pending input switch gates the combined action until switching completes', async () => {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'usb', label: 'USB input' },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  let finish!: (value: boolean) => void;
  host.switchInput.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));
  const selector = await screen.findByRole('combobox', { name: 'Audio input' });
  fireEvent.change(selector, { target: { value: 'usb' } });
  const button = screen.getByRole('button', {
    name: 'Track 1 REC/PLAY — Record',
  });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(host.record).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(button).toBeEnabled();
});

test('a stopped Loop plays before its next press starts overdub, without predicting engine state', () => {
  host.snapshot = {
    ...host.snapshot,
    tracks: [
      {
        ...host.snapshot.tracks[0],
        state: 'Stopped',
        canRecord: true,
        canPlay: true,
        lengthSamples: 48000,
      },
      host.snapshot.tracks[1],
    ],
  };
  render(<App />);
  const track = within(screen.getByRole('region', { name: 'Track 1 · Loop' }));
  fireEvent.click(
    track.getByRole('button', { name: 'Track 1 REC/PLAY — Play' }),
  );
  expect(host.play).toHaveBeenCalledWith(0);
  expect(host.record).not.toHaveBeenCalled();
  expect(track.getByTestId('track-state')).toHaveTextContent('Stopped');
  act(() => {
    host.snapshot = {
      ...host.snapshot,
      tracks: [
        { ...host.snapshot.tracks[0], state: 'Playing' },
        host.snapshot.tracks[1],
      ],
    };
    host.listeners.forEach((listener) => listener());
  });
  fireEvent.click(
    track.getByRole('button', { name: 'Track 1 REC/PLAY — Overdub' }),
  );
  expect(host.record).toHaveBeenCalledWith(0);
});

test('first capture shows elapsed capacity rather than an invented repeating cycle', () => {
  host.snapshot = {
    ...host.snapshot,
    tracks: [
      {
        ...host.snapshot.tracks[0],
        state: 'Recording',
        capturedSamples: 24000,
        lengthSamples: 24000,
      },
      host.snapshot.tracks[1],
    ],
  };
  render(<App />);
  const progress = screen.getAllByRole('progressbar')[0];
  expect(progress).toHaveAttribute('max', '2880000');
  expect(progress).toHaveAttribute('value', '24000');
});

test('settings remain available before startup and diagnostics are disclosed separately', () => {
  host.snapshot = { ...host.snapshot, status: 'idle' };
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Preferences' }));
  const settings = within(screen.getByRole('region', { name: 'Settings' }));
  const preference = settings.getByRole('checkbox', {
    name: 'Confirm before clearing',
  });
  expect(preference).toBeEnabled();
  fireEvent.click(preference);
  expect(
    JSON.parse(localStorage.getItem('loopbeats.settings.v1')!).confirmClearing,
  ).toBe(false);
  expect(
    settings.getByText(/Preferences do not save recordings/),
  ).toBeVisible();
  expect(screen.queryByText('Sample rate')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Diagnostics', { exact: true }));
  expect(
    screen.getByText('Start audio to see live diagnostics.'),
  ).toBeVisible();
});

test('Global STOP does nothing when all tracks are empty even with a retained running cycle', () => {
  host.snapshot = {
    ...host.snapshot,
    transport: {
      running: true,
      positionSamples: 12000,
      cycleLengthSamples: 48000,
    },
  };
  render(<App />);
  const stop = screen.getByRole('button', { name: 'Global Start' });
  expect(stop).toBeDisabled();
  fireEvent.click(stop);
  expect(host.stopTransport).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: /Track 1 REC\/PLAY/ }),
  ).toBeEnabled();
});

test('Global Start starts retained tracks without predicting engine state', () => {
  host.snapshot = {
    ...host.snapshot,
    transport: {
      running: true,
      positionSamples: 12000,
      cycleLengthSamples: 48000,
    },
    tracks: [
      {
        ...host.snapshot.tracks[0],
        state: 'Stopped',
        lengthSamples: 48000,
        canPlay: true,
      },
      {
        ...host.snapshot.tracks[1],
        state: 'Stopped',
        lengthSamples: 48000,
        canPlay: true,
      },
    ],
  };
  render(<App />);
  const start = screen.getByRole('button', { name: 'Global Start' });
  expect(start).toBeEnabled();
  fireEvent.click(start);
  expect(host.startTracks).toHaveBeenCalledOnce();
  expect(host.stopTransport).not.toHaveBeenCalled();
  expect(screen.getAllByTestId('track-state')[0]).toHaveTextContent('Stopped');
});

test.each(['Loop', 'OneShot'] as const)(
  '%s capture uses shared phase only for synchronized Loop recording',
  (mode) => {
    host.snapshot = {
      ...host.snapshot,
      transport: {
        running: true,
        positionSamples: 120000,
        cycleLengthSamples: 192000,
      },
      tracks: [
        {
          ...host.snapshot.tracks[0],
          state: 'Playing',
          lengthSamples: 192000,
          positionSamples: 120000,
        },
        {
          ...host.snapshot.tracks[1],
          mode,
          state: 'Recording',
          capturedSamples: 24000,
          captureLimitSamples: mode === 'Loop' ? 192000 : 2880000,
          lengthSamples: mode === 'Loop' ? 192000 : 24000,
          positionSamples: mode === 'Loop' ? 120000 : 0,
        },
      ],
    };
    render(<App />);
    const progress = screen.getAllByRole('progressbar');
    expect(progress[1]).toHaveAttribute(
      'max',
      mode === 'Loop' ? '192000' : '2880000',
    );
    expect(progress[1]).toHaveAttribute(
      'value',
      mode === 'Loop' ? '120000' : '24000',
    );
    act(() => {
      host.snapshot = {
        ...host.snapshot,
        tracks: [
          { ...host.snapshot.tracks[0], positionSamples: 12000 },
          {
            ...host.snapshot.tracks[1],
            capturedSamples: 108000,
            positionSamples: mode === 'Loop' ? 12000 : 0,
          },
        ],
      };
      host.listeners.forEach((listener) => listener());
    });
    expect(progress[1]).toHaveAttribute(
      'value',
      mode === 'Loop' ? '12000' : '108000',
    );
  },
);
