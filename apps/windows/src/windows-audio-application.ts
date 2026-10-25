import { invoke } from '@tauri-apps/api/core';
import type {
  AudioApplication,
  AudioApplicationSnapshot,
  AudioCapabilities,
  AudioCommandSubmission,
} from '@loopbeats/domain';

const emptyTrack = () => ({
  gain: 1,
  muted: false,
  mode: 'Loop' as const,
  canSetMode: false,
  canSetLoop: false,
  state: 'Empty' as const,
  capacitySamples: 0,
  captureLimitSamples: 0,
  capturedSamples: 0,
  canRecord: false,
  canPlay: false,
  canStop: false,
  lengthSamples: 0,
  positionSamples: 0,
});

const emptySnapshot = (): AudioApplicationSnapshot => ({
  engine: {
    masterGain: 1,
    transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
    tracks: [emptyTrack(), emptyTrack()],
    monitoring: false,
    processedFrames: 0,
    inputLevel: 0,
    outputLevel: 0,
  },
  host: { inputDeviceId: null, status: 'idle', error: null, sampleRate: null },
});

const unavailableCapabilities: AudioCapabilities = {
  inputDeviceSelection: false,
  outputDeviceSelection: false,
  monitoring: false,
  gainUpdateCoalescing: false,
  supportedFxScopes: [],
};

export class WindowsAudioApplication implements AudioApplication {
  private snapshot = emptySnapshot();
  private capabilities = unavailableCapabilities;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    void invoke<AudioCapabilities>('audio_capabilities')
      .then((capabilities) => {
        this.capabilities = capabilities;
        this.snapshot = { ...this.snapshot };
        this.publish();
      })
      .catch((error: unknown) => this.fail(error));
  }

  getApplicationSnapshot = () => this.snapshot;
  getCapabilities = () => this.capabilities;
  getSessionGeneration = () => this.generation;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  submit(): AudioCommandSubmission {
    return { status: 'rejected', reason: 'unavailable' };
  }

  async start(): Promise<void> {
    this.setStatus('starting', null);
    try {
      await invoke<void>('audio_host_start');
      this.setStatus('ready', null);
    } catch (error) {
      this.fail(error);
    }
  }

  async stop(): Promise<void> {
    this.setStatus('stopping', null);
    try {
      await invoke('audio_host_stop');
      this.generation += 1;
      this.snapshot = emptySnapshot();
      this.publish();
    } catch (error) {
      this.fail(error);
    }
  }

  reinitialize(): Promise<void> {
    return this.start();
  }

  private setStatus(
    status: 'starting' | 'ready' | 'error' | 'stopping',
    error: string | null,
  ) {
    this.snapshot = {
      ...this.snapshot,
      host: { ...this.snapshot.host, status, error },
    };
    this.publish();
  }

  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus('error', `Windows audio host error: ${message}`);
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
