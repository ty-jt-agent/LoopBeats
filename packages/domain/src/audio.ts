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
