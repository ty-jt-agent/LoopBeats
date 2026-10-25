import { afterEach, expect, test, vi } from 'vitest';
import { AudioClient } from './index';
import type { FxConfig } from '@loopbeats/domain';

type PortMessage = { data: Record<string, unknown> };

function emptyTrack() {
  return {
    gain: 1,
    muted: false,
    state: 'Empty',
    mode: 'Loop',
    canSetMode: false,
    canSetLoop: false,
    lengthSamples: 0,
    positionSamples: 0,
    capacitySamples: 256,
    capturedSamples: 0,
    captureLimitSamples: 256,
    canRecord: true,
    canPlay: false,
    canStop: false,
  };
}

async function createClientHarness() {
  let frames = 4;
  let holdAcknowledgements = false;
  let portHandler: ((event: PortMessage) => void) | undefined;
  const posted: Record<string, unknown>[] = [];
  const pendingCommands: Record<string, unknown>[] = [];
  const pendingOutcomes: Record<string, unknown>[] = [];
  const pendingFx: Record<string, unknown>[] = [];
  const deliver = (data: Record<string, unknown>) => portHandler?.({ data });
  const makeSnapshot = () => ({
    type: 'snapshot',
    recordingRevisions: [0, 0],
    masterGain: 1,
    transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
    tracks: [emptyTrack(), emptyTrack()],
    failed: false,
    monitoring: false,
    processedFrames: frames,
    inputLevel: 0,
    outputLevel: 0,
  });
  class MockAudioWorkletNode {
    onprocessorerror: (() => void) | null = null;
    port = {
      get onmessage() {
        return portHandler ?? null;
      },
      set onmessage(handler: ((event: PortMessage) => void) | null) {
        portHandler = handler ?? undefined;
      },
      close: () => {},
      postMessage: (message: Record<string, unknown>) => {
        posted.push(message);
        if (message.type === 'snapshot') deliver(makeSnapshot());
        if (message.type === 'application-command')
          pendingCommands.push(message);
        if (
          message.type === 'set-playback-fx' ||
          message.type === 'set-input-fx'
        )
          pendingFx.push(message);
        if (message.type === 'flush-command-outcomes') {
          if (!holdAcknowledgements) {
            for (const outcome of pendingOutcomes.splice(0)) deliver(outcome);
          }
          deliver({
            type: 'command-outcomes-flushed',
            requestId: message.requestId,
          });
        }
        if (message.type === 'advance-generation')
          deliver({
            type: 'generation-advanced',
            requestId: message.requestId,
            generation: message.generation,
          });
      },
    };
    connect() {
      return this;
    }
    disconnect() {}
  }
  class MockAudioContext {
    state = 'running';
    sampleRate = 48_000;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    onstatechange: (() => void) | null = null;
    resume = async () => {};
    close = async () => {
      this.state = 'closed';
    };
    createMediaStreamSource() {
      return {
        connect: (node: MockAudioWorkletNode) => node,
        disconnect: () => {},
      };
    }
  }
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [
          {
            getSettings: () => ({ deviceId: 'test-input' }),
            readyState: 'live',
            stop: () => {},
          },
        ],
        getTracks: () => [],
      }),
    },
  });
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    arrayBuffer: async () =>
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer,
  }));
  const client = new AudioClient({
    wasm: 'engine.wasm',
    worklet: 'processor.js',
  });
  const started = client.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await started;
  const runRenderBlock = () => {
    frames += 4;
    for (const command of pendingCommands.splice(0, 32)) {
      pendingOutcomes.push({
        type: 'application-command-outcome',
        commandId: command.commandId,
        generation: command.generation,
        status: 'applied',
        applicationFrame: frames - 4,
        blockSequence: frames / 4,
      });
    }
    deliver(makeSnapshot());
  };
  const replyToFx = (fx: Record<string, unknown>, error?: string) => {
    deliver({
      type: fx.type === 'set-input-fx' ? 'input-fx-reply' : 'playback-fx-reply',
      requestId: fx.requestId,
      scope: fx.scope,
      ...(error ? { error } : {}),
    });
  };
  return {
    client,
    posted,
    pendingFx,
    runRenderBlock,
    replyToFx,
    setHoldAcknowledgements: (hold: boolean) => {
      holdAcknowledgements = hold;
      if (!hold)
        for (const outcome of pendingOutcomes.splice(0)) deliver(outcome);
    },
    dispose: () => client.stop(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function createProcessor() {
  const messages: Record<string, unknown>[] = [];
  const gainCalls: number[] = [];
  const engine = {
    memory: { buffer: new ArrayBuffer(4096) },
    initialize: () => 1,
    input_ptr: () => 0,
    output_ptr: () => 1024,
    capacity: () => 256,
    process: (count: number) => count,
    set_track_gain: (_track: number, gain: number) => gainCalls.push(gain),
    set_track_mute: () => 0,
    set_master_gain: () => 0,
    set_monitoring: () => 0,
    set_mode: () => 0,
    record: () => 0,
    play: () => 0,
    stop_track: () => 0,
    clear: () => 0,
    stop_transport: () => 0,
    reset: () => 0,
    interrupt: () => 0,
    track_state: () => 0,
    can_play: () => 0,
    monitoring: () => 0,
  };
  let Processor!: new (options: unknown) => {
    port: { onmessage: (event: PortMessage) => void; messages: unknown[] };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  };
  class MockProcessor {
    port = {
      onmessage: () => {},
      messages,
      postMessage: (message: unknown) =>
        messages.push(message as Record<string, unknown>),
    };
  }
  vi.stubGlobal('AudioWorkletProcessor', MockProcessor);
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal(
    'registerProcessor',
    (_name: string, value: typeof Processor) => {
      Processor = value;
    },
  );
  vi.stubGlobal('WebAssembly', {
    ...WebAssembly,
    Instance: class {
      exports = engine;
    },
  });
  const processorModule = './processor.js';
  await import(processorModule);
  const processor = new Processor({
    processorOptions: { module: {}, generation: 4 },
  });
  const render = () => {
    const output = [new Float32Array(4), new Float32Array(4)];
    processor.process([[new Float32Array(4)]], [output]);
  };
  return { processor, render, messages, gainCalls };
}

test('applies accepted commands FIFO at the next render block and reports frame and block', async () => {
  const { processor, render, messages, gainCalls } = await createProcessor();
  processor.port.onmessage({
    data: {
      type: 'application-command',
      commandId: 1,
      generation: 4,
      command: { type: 'set-track-gain', trackId: 0, gain: 0.2 },
    },
  });
  processor.port.onmessage({
    data: {
      type: 'application-command',
      commandId: 2,
      generation: 4,
      command: { type: 'set-track-gain', trackId: 0, gain: 0.8 },
    },
  });
  expect(messages).toHaveLength(0);
  render();
  expect(gainCalls).toEqual([0.2, 0.8]);
  expect(messages).toHaveLength(0);
  processor.port.onmessage({
    data: { type: 'flush-command-outcomes', requestId: 1 },
  });
  expect(messages.slice(0, 2)).toMatchObject([
    {
      commandId: 1,
      generation: 4,
      status: 'applied',
      applicationFrame: 0,
      blockSequence: 1,
    },
    {
      commandId: 2,
      generation: 4,
      status: 'applied',
      applicationFrame: 0,
      blockSequence: 1,
    },
  ]);
  processor.port.onmessage({
    data: {
      type: 'application-command',
      commandId: 3,
      generation: 4,
      command: { type: 'set-track-gain', trackId: 0, gain: 0.5 },
    },
  });
  expect(messages).toHaveLength(3);
  render();
  expect(messages).toHaveLength(3);
  processor.port.onmessage({
    data: { type: 'flush-command-outcomes', requestId: 2 },
  });
  expect(messages[3]).toMatchObject({
    commandId: 3,
    status: 'applied',
    applicationFrame: 4,
    blockSequence: 2,
  });
});

test('rejects stale generations and bounds queued command admission', async () => {
  const { processor, render, messages } = await createProcessor();
  processor.port.onmessage({
    data: {
      type: 'application-command',
      commandId: 1,
      generation: 4,
      command: { type: 'record', trackId: 0 },
    },
  });
  processor.port.onmessage({
    data: { type: 'advance-generation', generation: 5, requestId: 1 },
  });
  expect(messages[0]).toMatchObject({
    commandId: 1,
    generation: 4,
    status: 'stale',
  });

  for (let commandId = 2; commandId <= 66; commandId++) {
    processor.port.onmessage({
      data: {
        type: 'application-command',
        commandId,
        generation: 5,
        command: { type: 'record', trackId: 0 },
      },
    });
  }
  expect(messages.at(-1)).toMatchObject({ commandId: 66, status: 'failed' });
  render();
  expect(
    messages.filter((message) => message.status === 'applied'),
  ).toHaveLength(0);
  render();
  expect(
    messages.filter((message) => message.status === 'applied'),
  ).toHaveLength(0);
  processor.port.onmessage({
    data: { type: 'flush-command-outcomes', requestId: 2 },
  });
  expect(
    messages.filter((message) => message.status === 'applied'),
  ).toHaveLength(64);
  expect(
    messages.filter(
      (message) => message.type === 'application-command-outcome',
    ),
  ).toHaveLength(66);
});

test('does not acknowledge out-of-range gain as applied', async () => {
  const { processor, render, messages, gainCalls } = await createProcessor();
  processor.port.onmessage({
    data: {
      type: 'application-command',
      commandId: 1,
      generation: 4,
      command: { type: 'set-master-gain', gain: 1.1 },
    },
  });
  render();
  expect(gainCalls).toEqual([]);
  processor.port.onmessage({
    data: { type: 'flush-command-outcomes', requestId: 1 },
  });
  expect(messages[0]).toMatchObject({
    commandId: 1,
    generation: 4,
    status: 'failed',
  });
});

test('reports capabilities and rejects before the acknowledgement window is full', () => {
  const client = new AudioClient({ wasm: '', worklet: '' });
  const initialSnapshot = client.getApplicationSnapshot();
  expect(initialSnapshot.host.status).toBe('idle');
  expect(initialSnapshot.engine).toHaveProperty('masterGain');
  expect(initialSnapshot.engine).not.toHaveProperty('status');
  expect(initialSnapshot.host).not.toHaveProperty('transport');
  expect(client.getCapabilities()).toMatchObject({
    inputDeviceSelection: true,
    outputDeviceSelection: false,
    monitoring: true,
    gainUpdateCoalescing: false,
  });
  expect(client.submit({ type: 'stop-transport' })).toEqual({
    status: 'rejected',
    reason: 'unavailable',
  });
});

test('stalled public acknowledgement delivery bounds admission while rendering continues', async () => {
  const harness = await createClientHarness();
  try {
    harness.setHoldAcknowledgements(true);
    const accepted = Array.from({ length: 64 }, () =>
      harness.client.submit({ type: 'stop-transport' }),
    );
    expect(
      accepted.every((submission) => submission.status === 'accepted'),
    ).toBe(true);
    expect(harness.client.submit({ type: 'stop-transport' })).toEqual({
      status: 'rejected',
      reason: 'overloaded',
    });

    harness.runRenderBlock();
    harness.runRenderBlock();
    expect(harness.client.getApplicationSnapshot().engine.processedFrames).toBe(
      12,
    );

    harness.setHoldAcknowledgements(false);
    const outcomes = await Promise.all(
      accepted.map((submission) =>
        submission.status === 'accepted'
          ? submission.outcome
          : Promise.reject(),
      ),
    );
    expect(outcomes).toHaveLength(64);
    expect(new Set(outcomes.map((outcome) => outcome.commandId)).size).toBe(64);
    expect(outcomes.every((outcome) => outcome.status === 'applied')).toBe(
      true,
    );
  } finally {
    await harness.dispose();
  }
});

test('lifecycle commands cancel queued FX targets only after dispatch', async () => {
  const harness = await createClientHarness();
  try {
    const first: FxConfig = { type: 'LowPass', cutoffHz: 900, bypassed: false };
    const queued: FxConfig = {
      type: 'LowPass',
      cutoffHz: 1200,
      bypassed: false,
    };
    harness.client.setPlaybackFx(1, first);
    harness.client.setPlaybackFx(1, queued);
    const playbackFlight = harness.pendingFx[0];
    const reset = harness.client.submit({ type: 'reset' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      harness.posted.some(
        (message) =>
          message.type === 'application-command' &&
          (message.command as { type?: string }).type === 'reset',
      ),
    ).toBe(true);
    harness.replyToFx(playbackFlight);
    expect(harness.pendingFx).toHaveLength(1);
    expect(reset.status).toBe('accepted');

    harness.client.setInputFx(first);
    harness.client.setInputFx(queued);
    const inputFlight = harness.pendingFx.at(-1)!;
    const stop = harness.client.submit({ type: 'stop-transport' });
    expect(
      harness.posted.some(
        (message) =>
          message.type === 'application-command' &&
          (message.command as { type?: string }).type === 'stop-transport',
      ),
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    harness.replyToFx(inputFlight);
    expect(harness.pendingFx).toHaveLength(2);
    expect(stop.status).toBe('accepted');

    harness.client.setPlaybackFx(1, first);
    harness.client.setPlaybackFx(1, queued);
    const trackOneFlight = harness.pendingFx.at(-1)!;
    const trackStop = harness.client.submit({ type: 'stop-track', trackId: 0 });
    expect(
      harness.posted.some(
        (message) =>
          message.type === 'application-command' &&
          (message.command as { type?: string }).type === 'stop-track',
      ),
    ).toBe(true);
    harness.replyToFx(trackOneFlight);
    expect(harness.pendingFx).toHaveLength(3);
    expect(trackStop.status).toBe('accepted');
  } finally {
    await harness.dispose();
  }
});
