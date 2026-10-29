export type PlaybackMode = 'Loop' | 'OneShot';
export type TrackId = 0 | 1;
export type FxScope = 0 | 1 | 2 | 3;
export type FxConfig =
  | { readonly type: 'None' }
  | {
      readonly type: 'LowPass';
      readonly cutoffHz: number;
      readonly bypassed: boolean;
    };
export interface FxSnapshot {
  readonly config: FxConfig;
  readonly transitioning: boolean;
  readonly removing: boolean;
}
export type SessionFxSnapshot = readonly [
  FxSnapshot,
  FxSnapshot,
  FxSnapshot,
  FxSnapshot,
];
export type AudioStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'interrupted'
  | 'recovering'
  | 'stopping'
  | 'error';
export interface TrackSnapshot {
  readonly gain: number;
  readonly muted: boolean;
  readonly mode: PlaybackMode;
  readonly canSetMode: boolean;
  readonly canSetLoop: boolean;
  readonly state: 'Empty' | 'Recording' | 'Playing' | 'Stopped' | 'Overdubbing';
  readonly capacitySamples: number;
  readonly captureLimitSamples: number;
  readonly capturedSamples: number;
  readonly canRecord: boolean;
  readonly canPlay: boolean;
  readonly canStop: boolean;
  readonly lengthSamples: number;
  readonly positionSamples: number;
}
export interface TransportSnapshot {
  readonly running: boolean;
  readonly positionSamples: number;
  readonly cycleLengthSamples: number;
}
export interface AudioSnapshot {
  readonly fx?: SessionFxSnapshot;
  readonly inputFxPending?: boolean;
  readonly inputFxError?: string | null;
  readonly masterFxError?: string | null;
  readonly playbackFxPending?: readonly boolean[];
  readonly playbackFxErrors?: readonly (string | null)[];
  readonly inputDeviceId: string | null;
  readonly masterGain: number;
  readonly transport: TransportSnapshot;
  readonly tracks: readonly [TrackSnapshot, TrackSnapshot];
  readonly status: AudioStatus;
  readonly monitoring: boolean;
  readonly error: string | null;
  readonly sampleRate: number | null;
  readonly processedFrames: number;
  readonly inputLevel: number;
  readonly outputLevel: number;
  readonly wasapiDiagnostics?: WasapiDiagnosticsSnapshot | null;
}
export type AudioCommand =
  | { type: 'set-track-gain'; trackId: TrackId; gain: number }
  | { type: 'set-track-mute'; trackId: TrackId; muted: boolean }
  | { type: 'set-master-gain'; gain: number }
  | { type: 'monitoring'; enabled: boolean }
  | { type: 'snapshot' }
  | { type: 'set-mode'; trackId: TrackId; mode: PlaybackMode }
  | { type: 'record'; trackId: TrackId }
  | { type: 'play'; trackId: TrackId }
  | { type: 'stop-track'; trackId: TrackId }
  | { type: 'stop-transport' }
  | { type: 'start-tracks' }
  | { type: 'clear'; trackId: TrackId }
  | { type: 'reset' }
  | { type: 'interrupt' };

/** Commands in the platform-neutral application contract. Snapshot polling is host-owned. */
export type AudioApplicationCommand = Exclude<
  AudioCommand,
  { type: 'snapshot' }
>;

export type AudioCommandOutcome =
  | {
      readonly commandId: number;
      readonly generation: number;
      readonly status: 'applied';
      readonly applicationFrame: number;
      readonly blockSequence: number;
    }
  | {
      readonly commandId: number;
      readonly generation: number;
      readonly status: 'superseded' | 'stale' | 'failed';
      readonly replacementCommandId?: number;
      readonly error?: string;
    };

export type AudioCommandSubmission =
  | {
      readonly status: 'accepted';
      readonly commandId: number;
      readonly generation: number;
      readonly outcome: Promise<AudioCommandOutcome>;
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'unavailable' | 'overloaded' | 'invalid-command';
    };

export interface AudioCapabilities {
  readonly inputDeviceSelection: boolean;
  readonly outputDeviceSelection: boolean;
  readonly monitoring: boolean;
  readonly gainUpdateCoalescing: boolean;
  readonly supportedFxScopes: readonly FxScope[];
}

export type AudioEngineSnapshot = Pick<
  AudioSnapshot,
  | 'fx'
  | 'inputFxPending'
  | 'inputFxError'
  | 'masterFxError'
  | 'playbackFxPending'
  | 'playbackFxErrors'
  | 'masterGain'
  | 'transport'
  | 'tracks'
  | 'monitoring'
  | 'processedFrames'
  | 'inputLevel'
  | 'outputLevel'
>;

export type AudioHostSnapshot = Pick<
  AudioSnapshot,
  'inputDeviceId' | 'status' | 'error' | 'sampleRate' | 'wasapiDiagnostics'
> & {
  readonly captureInterruption?: CaptureInterruptionSnapshot | null;
};

export interface WasapiStreamSnapshot {
  readonly direction: 'capture' | 'render';
  readonly endpointId: string;
  readonly endpointName: string;
  readonly adapterName: string;
  readonly driver:
    | {
        readonly status: 'available';
        readonly name: string;
        readonly version: string | null;
      }
    | { readonly status: 'unavailable'; readonly reason: string };
  readonly requestedSampleRate: number;
  readonly actualSampleRate: number;
  readonly channelCount: number;
  readonly sampleFormat: 'Float32' | 'Signed16' | 'Signed24' | 'Signed32';
  readonly requestedPeriodFrames: number;
  readonly actualPeriodFrames: number;
  readonly bufferFrames: number;
  readonly fallback:
    'low-period-unsupported' | 'i-audio-client3-unavailable' | null;
}

export interface WasapiDiagnosticsSnapshot {
  readonly capture: WasapiStreamSnapshot;
  readonly render: WasapiStreamSnapshot;
  readonly captureDiscontinuities: number;
  readonly captureOverflows: number;
  readonly renderFailures: number;
  readonly deviceFailed: boolean;
  readonly captureQueueFrames: number;
  readonly captureQueueCapacityFrames: number;
  readonly captureResamplingCorrectionPpm: number;
  readonly lastCaptureDiscontinuity:
    | 'wasapi-reported'
    | 'capture-packet-gap'
    | 'capture-queue-overflow'
    | 'render-input-underflow'
    | 'capture-backlog-discarded'
    | null;
  readonly lastCaptureImpact:
    | { readonly type: 'playback-continued' }
    | {
        readonly type: 'initial-recording-discarded' | 'overdub-may-be-partial';
        readonly trackId: TrackId;
      }
    | null;
}

export interface WasapiDiagnosticsSample {
  readonly timestampUtc: string;
  readonly processedFrames: number;
  readonly captureDiscontinuities: number;
  readonly captureOverflows: number;
  readonly renderFailures: number;
  readonly deviceFailed: boolean;
  readonly captureQueueFrames: number;
  readonly captureQueueCapacityFrames: number;
  readonly captureResamplingCorrectionPpm: number;
  readonly lastCaptureDiscontinuity: WasapiDiagnosticsSnapshot['lastCaptureDiscontinuity'];
  readonly lastCaptureImpact: WasapiDiagnosticsSnapshot['lastCaptureImpact'];
}

export interface CaptureInterruptionSnapshot {
  readonly reason:
    | 'wasapi-reported'
    | 'capture-packet-gap'
    | 'capture-queue-overflow'
    | 'render-input-underflow'
    | 'capture-backlog-discarded';
  readonly initialRecordingDiscardedTracks: readonly TrackId[];
  readonly overdubMayBePartialTracks: readonly TrackId[];
  readonly completedRecordingsRetained: true;
  readonly transportReset: true;
  readonly monitoringDisabled: true;
}

export interface AudioApplicationSnapshot {
  readonly engine: AudioEngineSnapshot;
  readonly host: AudioHostSnapshot;
}

/** Minimal host conformance seam. Platform-specific session storage stays in adapters. */
export interface AudioApplication {
  getApplicationSnapshot(): AudioApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  getCapabilities(): AudioCapabilities;
  getSessionGeneration(): number;
  submit(command: AudioApplicationCommand): AudioCommandSubmission;
  start(inputDeviceId?: string): Promise<void>;
  stop(): Promise<void>;
  reinitialize(): Promise<void>;
}
