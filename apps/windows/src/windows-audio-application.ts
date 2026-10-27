import { invoke } from '@tauri-apps/api/core';
import type {
  AudioApplication,
  AudioApplicationCommand,
  AudioApplicationSnapshot,
  AudioCapabilities,
  AudioCommandOutcome,
  AudioCommandSubmission,
  FxConfig,
  FxScope,
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
  monitoring: true,
  gainUpdateCoalescing: false,
  supportedFxScopes: [0, 3],
};

export class WindowsAudioApplication implements AudioApplication {
  private snapshot = emptySnapshot();
  private capabilities = unavailableCapabilities;
  private generation = 0;
  private nextCommandId = 1;
  private readonly pendingFx = [0, 0, 0, 0];
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;
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

  submit(command: AudioApplicationCommand): AudioCommandSubmission {
    if (this.snapshot.host.status !== 'ready')
      return { status: 'rejected', reason: 'unavailable' };
    const commandId = this.nextCommandId++;
    const generation = this.generation;
    const outcome = invoke<AudioCommandOutcome>('audio_submit', {
      command,
      expectedGeneration: generation,
    })
      .then((result) => {
        this.generation = Math.max(this.generation, result.generation);
        return { ...result, commandId, generation: result.generation };
      })
      .catch((error: unknown): AudioCommandOutcome => ({
        commandId,
        generation,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }));
    return { status: 'accepted', commandId, generation, outcome };
  }

  setFx(scope: FxScope, config: FxConfig): void {
    if (this.snapshot.host.status !== 'ready') return;
    const generation = this.generation;
    this.updateFxPending(scope, 1);
    void invoke<AudioCommandOutcome>('audio_submit', {
      command: { type: 'set-fx', scope, config },
      expectedGeneration: generation,
    })
      .then(async (outcome) => {
        if (outcome.status !== 'applied') {
          this.setFxError(
            scope,
            outcome.error ??
              'The native engine could not apply this FX target.',
          );
          return;
        }
        this.setFxError(scope, null);
        await this.refreshSnapshot();
      })
      .catch((error: unknown) =>
        this.setFxError(
          scope,
          error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => this.updateFxPending(scope, -1));
  }

  async start(): Promise<void> {
    this.setStatus('starting', null);
    try {
      this.generation = await invoke<number>('audio_host_start', {
        expectedGeneration: this.generation,
      });
      this.setStatus('ready', null);
      this.startSnapshotPolling();
      await this.refreshSnapshot();
    } catch (error) {
      this.fail(error);
    }
  }

  async stop(): Promise<void> {
    this.setStatus('stopping', null);
    try {
      const generation = await invoke<number>('audio_host_stop', {
        expectedGeneration: this.generation,
      });
      this.stopSnapshotPolling();
      this.generation = generation;
      this.snapshot = emptySnapshot();
      this.publish();
    } catch (error) {
      this.fail(error);
    }
  }

  reinitialize(): Promise<void> {
    return this.start();
  }

  private startSnapshotPolling() {
    this.stopSnapshotPolling();
    this.snapshotTimer = setInterval(() => void this.refreshSnapshot(), 50);
  }

  private stopSnapshotPolling() {
    if (this.snapshotTimer !== undefined) clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
  }

  private async refreshSnapshot() {
    if (!['ready', 'interrupted'].includes(this.snapshot.host.status)) return;
    try {
      const snapshot = await invoke<
        AudioApplicationSnapshot & { generation: number }
      >('audio_snapshot');
      this.generation = snapshot.generation;
      this.snapshot = this.withPendingFx(snapshot);
      this.publish();
    } catch (error) {
      this.fail(error);
    }
  }

  private setFxError(scope: FxScope, error: string | null) {
    const engine = { ...this.snapshot.engine };
    if (scope === 0) engine.inputFxError = error;
    else if (scope === 3) engine.masterFxError = error;
    else {
      const errors = [...(engine.playbackFxErrors ?? [null, null])];
      errors[scope - 1] = error;
      engine.playbackFxErrors = errors;
    }
    this.snapshot = { ...this.snapshot, engine };
    this.publish();
  }

  private updateFxPending(scope: FxScope, delta: number) {
    this.pendingFx[scope] = Math.max(0, this.pendingFx[scope] + delta);
    this.snapshot = this.withPendingFx(this.snapshot);
    this.publish();
  }

  private withPendingFx(snapshot: AudioApplicationSnapshot) {
    const engine = { ...snapshot.engine };
    engine.inputFxPending = this.pendingFx[0] > 0;
    engine.playbackFxPending = [
      this.pendingFx[1] > 0,
      this.pendingFx[2] > 0,
      this.pendingFx[3] > 0,
    ];
    return { ...snapshot, engine };
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
