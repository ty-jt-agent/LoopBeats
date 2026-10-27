import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  AudioApplicationSnapshot,
  FxConfig,
  FxSnapshot,
  TrackSnapshot,
} from '@loopbeats/domain';
import { App } from '../../web/src/App';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import { WindowsAudioApplication } from './windows-audio-application';

const emptyTrack = (): TrackSnapshot => ({
  gain: 1,
  muted: false,
  mode: 'Loop',
  canSetMode: true,
  canSetLoop: true,
  state: 'Empty',
  capacitySamples: 256,
  captureLimitSamples: 256,
  capturedSamples: 0,
  canRecord: true,
  canPlay: false,
  canStop: false,
  lengthSamples: 0,
  positionSamples: 0,
});
const fxSlot = (config: FxConfig): FxSnapshot => ({
  config,
  transitioning: false,
  removing: false,
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

test('shared UI records two tracks, overdubs, monitors input, and enables Input FX through the Windows adapter', async () => {
  const generation = 1;
  let commandId = 0;
  let current: AudioApplicationSnapshot = {
    engine: {
      fx: [
        fxSlot({ type: 'None' }),
        fxSlot({ type: 'None' }),
        fxSlot({ type: 'None' }),
        fxSlot({ type: 'None' }),
      ],
      masterGain: 1,
      transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
      tracks: [emptyTrack(), emptyTrack()],
      monitoring: false,
      processedFrames: 0,
      inputLevel: 0,
      outputLevel: 0,
    },
    host: {
      inputDeviceId: null,
      status: 'idle',
      error: null,
      sampleRate: null,
    },
  };

  native.invoke.mockImplementation(
    async (name: string, args?: { command?: Record<string, unknown> }) => {
      if (name === 'audio_capabilities')
        return {
          inputDeviceSelection: false,
          outputDeviceSelection: false,
          monitoring: true,
          gainUpdateCoalescing: false,
          supportedFxScopes: [0, 3],
        };
      if (name === 'audio_host_start') {
        current = {
          ...current,
          host: { ...current.host, status: 'ready', sampleRate: 48_000 },
        };
        return generation;
      }
      if (name === 'audio_snapshot') return { ...current, generation };
      if (name === 'audio_submit') {
        const command = args?.command;
        const tracks = [...current.engine.tracks] as [
          TrackSnapshot,
          TrackSnapshot,
        ];
        let fx = current.engine.fx;
        let monitoring = current.engine.monitoring;
        if (command?.type === 'monitoring')
          monitoring = command.enabled as boolean;
        if (command?.type === 'record') {
          const trackId = command.trackId as 0 | 1;
          const state = tracks[trackId].state;
          const nextState =
            state === 'Empty'
              ? 'Recording'
              : state === 'Recording'
                ? 'Playing'
                : state === 'Playing'
                  ? 'Overdubbing'
                  : 'Playing';
          tracks[trackId] = {
            ...tracks[trackId],
            state: nextState,
            canRecord: true,
            canPlay: false,
            canStop: true,
            capturedSamples: nextState === 'Playing' ? 256 : 128,
            lengthSamples: nextState === 'Playing' ? 256 : 128,
          };
          if (nextState === 'Playing')
            current = {
              ...current,
              engine: {
                ...current.engine,
                transport: {
                  running: true,
                  positionSamples: 0,
                  cycleLengthSamples: 256,
                },
              },
            };
        }
        if (command?.type === 'set-fx') {
          const nextFx = [...(fx ?? [])] as unknown as [
            FxSnapshot,
            FxSnapshot,
            FxSnapshot,
            FxSnapshot,
          ];
          nextFx[command.scope as number] = fxSlot(command.config as FxConfig);
          fx = nextFx;
        }
        current = {
          ...current,
          engine: { ...current.engine, tracks, monitoring, fx },
        };
        return {
          commandId: ++commandId,
          generation,
          status: 'applied',
          applicationFrame: 128,
          blockSequence: 2,
        };
      }
      if (name === 'audio_host_stop') return generation + 1;
      throw new Error(`Unexpected native command ${name}`);
    },
  );

  const audio = new WindowsAudioApplication();
  render(<App audio={audio} />);
  await Promise.resolve();
  fireEvent.click(screen.getByRole('button', { name: 'Start audio' }));
  await screen.findByText('Enable monitoring');
  fireEvent.click(screen.getByRole('button', { name: 'Enable monitoring' }));
  await screen.findByText('Monitoring on', { exact: true });

  fireEvent.click(
    screen.getByRole('button', { name: 'Track 1 REC/PLAY — Record' }),
  );
  await screen.findByRole('button', {
    name: 'Track 1 REC/PLAY — Finish recording',
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Track 1 REC/PLAY — Finish recording' }),
  );
  await screen.findByRole('button', { name: 'Track 1 REC/PLAY — Overdub' });

  const trackTwo = within(
    screen.getByRole('region', { name: 'Track 2 · Loop' }),
  );
  fireEvent.click(
    trackTwo.getByRole('button', { name: 'Track 2 REC/PLAY — Record' }),
  );
  await screen.findByRole('button', {
    name: 'Track 2 REC/PLAY — Finish recording',
  });
  fireEvent.click(
    trackTwo.getByRole('button', {
      name: 'Track 2 REC/PLAY — Finish recording',
    }),
  );
  await screen.findByRole('button', { name: 'Track 2 REC/PLAY — Overdub' });

  fireEvent.click(
    screen.getByRole('button', { name: 'Track 1 REC/PLAY — Overdub' }),
  );
  await screen.findByRole('button', {
    name: 'Track 1 REC/PLAY — Finish overdub',
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Track 1 REC/PLAY — Finish overdub' }),
  );
  await screen.findByRole('button', { name: 'Track 1 REC/PLAY — Overdub' });

  fireEvent.click(screen.getByRole('button', { name: 'Open Input effects' }));
  const editor = screen.getByRole('region', { name: 'Input effects' });
  fireEvent.change(
    within(editor).getByRole('combobox', { name: 'Input effect' }),
    { target: { value: 'LowPass' } },
  );
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith(
      'audio_submit',
      expect.objectContaining({
        command: expect.objectContaining({ type: 'set-fx', scope: 0 }),
        expectedGeneration: generation,
      }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  fireEvent.click(
    within(editor).getByRole('button', { name: 'Enable Input filter' }),
  );
  await waitFor(() =>
    expect(current.engine.fx?.[0]).toMatchObject({
      config: { type: 'LowPass', bypassed: false },
    }),
  );
  await screen.findByText('Input: On', { exact: true });
  current = {
    ...current,
    host: {
      ...current.host,
      status: 'interrupted',
      captureInterruption: {
        reason: 'capture-packet-gap',
        initialRecordingDiscardedTracks: [],
        overdubMayBePartialTracks: [0],
        completedRecordingsRetained: true,
        transportReset: true,
        monitoringDisabled: true,
      },
    },
  };
  expect(await screen.findByText(/Capture interrupted/)).toHaveTextContent(
    'Track 1 overdub may be partial; additions already written were retained.',
  );
  await audio.stop();
});
