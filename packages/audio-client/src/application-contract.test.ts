import { afterEach, expect, test, vi } from 'vitest';
import { AudioClient } from './index';

type PortMessage = { data: Record<string, unknown> };

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
