// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import type {
  AudioApplicationSnapshot,
  WasapiDiagnosticsSnapshot,
} from '@loopbeats/domain';

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
  status: 'ready' | 'interrupted' | 'error' = 'ready',
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
    host: {
      inputDeviceId: null,
      status,
      error: status === 'error' ? 'A Windows audio device failed.' : null,
      sampleRate: 48_000,
    },
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
      if (name === 'audio_host_stop') return 2;
      throw new Error(`Unexpected native command: ${name}`);
    },
  );

  const app = new WindowsAudioApplication();
  await Promise.resolve();
  await app.start();
  expect(app.getApplicationSnapshot().host.status).toBe('ready');
  expect(app.getCapabilities().supportedFxScopes).toEqual([0, 3]);
  expect(bridge.invoke).toHaveBeenCalledWith('audio_host_start', {
    expectedGeneration: 0,
  });

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
    command: { type: 'record', trackId: 0 },
    expectedGeneration: 1,
  });
  expect(bridge.invoke).toHaveBeenCalledWith('audio_submit', {
    command: { type: 'set-track-gain', trackId: 1, gain: 0.35 },
    expectedGeneration: 1,
  });
  expect(bridge.invoke).toHaveBeenCalledWith('audio_submit', {
    command: { type: 'set-master-gain', gain: 0.6 },
    expectedGeneration: 1,
  });

  app.setFx(0, { type: 'LowPass', cutoffHz: 2_000, bypassed: false });
  await Promise.resolve();
  expect(bridge.invoke).toHaveBeenCalledWith('audio_submit', {
    command: {
      type: 'set-fx',
      scope: 0,
      config: { type: 'LowPass', cutoffHz: 2_000, bypassed: false },
    },
    expectedGeneration: 1,
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

test('Windows adapter retains one-second host diagnostics samples for export', async () => {
  vi.useFakeTimers();
  const wasapiDiagnostics: WasapiDiagnosticsSnapshot = {
    capture: {
      direction: 'capture',
      endpointId: 'capture-id',
      endpointName: 'NZXT USB MIC',
      adapterName: 'USB Audio Device',
      driver: { status: 'available', name: 'USB Audio', version: '1.0' },
      requestedSampleRate: 48_000,
      actualSampleRate: 48_000,
      channelCount: 1,
      sampleFormat: 'Float32',
      requestedPeriodFrames: 128,
      actualPeriodFrames: 128,
      bufferFrames: 192,
      fallback: null,
    },
    render: {
      direction: 'render',
      endpointId: 'render-id',
      endpointName: 'Realtek Audio',
      adapterName: 'Realtek',
      driver: { status: 'available', name: 'Realtek', version: '1.0' },
      requestedSampleRate: 48_000,
      actualSampleRate: 48_000,
      channelCount: 2,
      sampleFormat: 'Float32',
      requestedPeriodFrames: 128,
      actualPeriodFrames: 128,
      bufferFrames: 192,
      fallback: null,
    },
    captureDiscontinuities: 0,
    captureOverflows: 0,
    renderFailures: 0,
    deviceFailed: false,
    captureQueueFrames: 960,
    captureQueueCapacityFrames: 16_384,
    captureResamplingCorrectionPpm: -12,
    lastCaptureDiscontinuity: null,
    lastCaptureImpact: null,
  };
  bridge.invoke.mockImplementation(async (name: string) => {
    if (name === 'audio_capabilities')
      return {
        inputDeviceSelection: false,
        outputDeviceSelection: false,
        monitoring: true,
        gainUpdateCoalescing: false,
        supportedFxScopes: [0, 3],
      };
    if (name === 'audio_host_start') return 1;
    if (name === 'audio_snapshot')
      return {
        ...snapshot(),
        host: { ...snapshot().host, wasapiDiagnostics },
        generation: 1,
      };
    if (name === 'audio_host_stop') return 2;
    throw new Error(`Unexpected native command: ${name}`);
  });

  const app = new WindowsAudioApplication();
  await Promise.resolve();
  await app.start();
  expect(app.getWasapiDiagnosticsTrace()).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(999);
  expect(app.getWasapiDiagnosticsTrace()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);

  const trace = app.getWasapiDiagnosticsTrace();
  expect(trace).toHaveLength(2);
  expect(trace[1].captureQueueFrames).toBe(960);
  expect(trace[1].captureResamplingCorrectionPpm).toBe(-12);
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
    if (name === 'audio_host_stop') return nativeGeneration + 1;
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

test('a delayed command keeps its originating generation across failure and recovery', async () => {
  vi.useFakeTimers();
  let nativeGeneration = 1;
  let hostStatus: 'ready' | 'error' = 'ready';
  let resolveOldCommand!: (outcome: {
    commandId: number;
    generation: number;
    status: 'failed';
  }) => void;
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
      nativeGeneration = hostStatus === 'ready' ? 1 : 3;
      hostStatus = 'ready';
      return nativeGeneration;
    }
    if (name === 'audio_snapshot')
      return {
        ...snapshot(hostStatus),
        generation: nativeGeneration,
      };
    if (name === 'audio_submit')
      return new Promise((resolve) => {
        resolveOldCommand = resolve;
      });
    if (name === 'audio_host_stop') return nativeGeneration + 1;
    throw new Error(`Unexpected native command: ${name}`);
  });

  const app = new WindowsAudioApplication();
  await Promise.resolve();
  await app.start();
  const oldCommand = app.submit({ type: 'record', trackId: 0 });
  expect(oldCommand.status).toBe('accepted');
  expect(bridge.invoke).toHaveBeenCalledWith('audio_submit', {
    command: { type: 'record', trackId: 0 },
    expectedGeneration: 1,
  });

  hostStatus = 'error';
  nativeGeneration = 2;
  await vi.advanceTimersByTimeAsync(50);
  expect(app.getApplicationSnapshot().host.status).toBe('error');
  await app.reinitialize();
  expect(app.getSessionGeneration()).toBe(3);
  expect(bridge.invoke).toHaveBeenLastCalledWith('audio_snapshot');

  if (oldCommand.status !== 'accepted')
    throw new Error(
      'The old command should have been admitted by the adapter.',
    );
  resolveOldCommand({ commandId: 1, generation: 1, status: 'failed' });
  expect((await oldCommand.outcome).status).toBe('failed');
  expect(app.getSessionGeneration()).toBe(3);
  await app.stop();
});
