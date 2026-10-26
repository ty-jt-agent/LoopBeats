// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import type { AudioApplicationSnapshot } from '@loopbeats/domain';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));

import { WindowsAudioApplication } from './windows-audio-application';

function emptyTrack() {
  return {
    gain: 1,
    muted: false,
    mode: 'Loop' as const,
    canSetMode: true,
    canSetLoop: true,
    state: 'Empty' as const,
    capacitySamples: 256,
    captureLimitSamples: 256,
    capturedSamples: 0,
    canRecord: true,
    canPlay: false,
    canStop: false,
    lengthSamples: 0,
    positionSamples: 0,
  };
}

function snapshot(
  status: 'ready' | 'interrupted' = 'ready',
): AudioApplicationSnapshot {
  return {
    engine: {
      masterGain: 1,
      transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
      tracks: [emptyTrack(), emptyTrack()],
      monitoring: false,
      processedFrames: 0,
      inputLevel: 0,
      outputLevel: 0,
    },
    host: { inputDeviceId: null, status, error: null, sampleRate: 48_000 },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('Windows adapter starts the native host and returns engine-applied workflow outcomes', async () => {
  vi.useFakeTimers();
  let rejectFx = false;
  bridge.invoke.mockImplementation(
    async (name: string, args?: { command?: unknown }) => {
      if (name === 'audio_capabilities')
        return {
          inputDeviceSelection: false,
          outputDeviceSelection: false,
          monitoring: true,
          gainUpdateCoalescing: false,
          supportedFxScopes: [0, 3],
        };
      if (name === 'audio_host_start') return 1;
      if (name === 'audio_snapshot') return { ...snapshot(), generation: 1 };
      if (
        name === 'audio_submit' &&
        (args?.command as { type?: string } | undefined)?.type === 'set-fx' &&
        rejectFx
      )
        return {
          commandId: 42,
          generation: 1,
          status: 'failed',
          error: 'FX slot is transitioning.',
        };
      if (name === 'audio_submit')
        return {
          commandId: 41,
          generation: 1,
          status: 'applied',
          applicationFrame: 128,
          blockSequence: 3,
          submitted: args?.command,
        };
      if (name === 'audio_host_stop') return undefined;
      throw new Error(`Unexpected native command: ${name}`);
    },
  );

  const app = new WindowsAudioApplication();
  await Promise.resolve();
  await app.start();
  expect(app.getApplicationSnapshot().host.status).toBe('ready');
  expect(app.getCapabilities().supportedFxScopes).toEqual([0, 3]);

  const record = app.submit({ type: 'record', trackId: 0 });
  const monitor = app.submit({ type: 'monitoring', enabled: true });
  const trackGain = app.submit({
    type: 'set-track-gain',
    trackId: 1,
    gain: 0.35,
  });
  const masterGain = app.submit({ type: 'set-master-gain', gain: 0.6 });
  expect(record.status).toBe('accepted');
  expect(monitor.status).toBe('accepted');
  expect(trackGain.status).toBe('accepted');
  expect(masterGain.status).toBe('accepted');
  if (
    record.status !== 'accepted' ||
    monitor.status !== 'accepted' ||
    trackGain.status !== 'accepted' ||
    masterGain.status !== 'accepted'
  )
    throw new Error('Native commands should be accepted while audio is ready.');
  const outcomes = await Promise.all([
    record.outcome,
    monitor.outcome,
    trackGain.outcome,
    masterGain.outcome,
  ]);
  expect(outcomes).toEqual([
    expect.objectContaining({
      status: 'applied',
      applicationFrame: 128,
      blockSequence: 3,
    }),
    expect.objectContaining({
      status: 'applied',
      applicationFrame: 128,
      blockSequence: 3,
    }),
    expect.objectContaining({ status: 'applied' }),
    expect.objectContaining({ status: 'applied' }),
  ]);
  expect(bridge.invoke).toHaveBeenCalledWith('audio_submit', {
    command: { type: 'set-track-gain', trackId: 1, gain: 0.35 },
  });
  expect(bridge.invoke).toHaveBeenCalledWith('audio_submit', {
    command: { type: 'set-master-gain', gain: 0.6 },
  });

  app.setFx(0, { type: 'LowPass', cutoffHz: 2_000, bypassed: false });
  await Promise.resolve();
  expect(bridge.invoke).toHaveBeenCalledWith('audio_submit', {
    command: {
      type: 'set-fx',
      scope: 0,
      config: { type: 'LowPass', cutoffHz: 2_000, bypassed: false },
    },
  });
  rejectFx = true;
  app.setFx(0, { type: 'LowPass', cutoffHz: 1_200, bypassed: false });
  await Promise.resolve();
  await Promise.resolve();
  expect(app.getApplicationSnapshot().engine.inputFxError).toBe(
    'FX slot is transitioning.',
  );
  expect(app.getApplicationSnapshot().host.status).toBe('ready');
  await app.stop();
});

test('interruption snapshots advance generation and explicit reinitialize reaches the native host', async () => {
  vi.useFakeTimers();
  let nativeGeneration = 1;
  let hostSnapshot: 'ready' | 'interrupted' = 'ready';
  bridge.invoke.mockImplementation(async (name: string) => {
    if (name === 'audio_capabilities')
      return {
        inputDeviceSelection: false,
        outputDeviceSelection: false,
        monitoring: true,
        gainUpdateCoalescing: false,
        supportedFxScopes: [0, 3],
      };
    if (name === 'audio_host_start') {
      hostSnapshot = 'ready';
      return ++nativeGeneration;
    }
    if (name === 'audio_snapshot')
      return { ...snapshot(hostSnapshot), generation: nativeGeneration };
    if (name === 'audio_host_stop') return undefined;
    throw new Error(`Unexpected native command: ${name}`);
  });
  const app = new WindowsAudioApplication();
  await Promise.resolve();
  await app.start();
  hostSnapshot = 'interrupted';
  await vi.advanceTimersByTimeAsync(50);
  expect(app.getApplicationSnapshot().host.status).toBe('interrupted');
  expect(app.getSessionGeneration()).toBe(2);
  await app.reinitialize();
  expect(app.getApplicationSnapshot().host.status).toBe('ready');
  expect(app.getSessionGeneration()).toBe(3);
  await app.stop();
});
