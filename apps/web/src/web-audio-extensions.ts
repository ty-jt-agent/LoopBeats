import type { FxConfig, FxScope } from '@loopbeats/domain';
import type {
  FxCutoffAdjustment,
  RecoveryState,
  SessionExportOptions,
  SessionImportOptions,
} from '@loopbeats/audio-client';

/** Browser-only capabilities kept outside the shared audio application contract. */
export interface WebAudioExtensions {
  listInputDevices?(): Promise<readonly { id: string; label: string }[]>;
  subscribeInputDeviceChanges?(listener: () => void): () => void;
  subscribe(listener: () => void): () => void;
  getRecoverySnapshot(): RecoveryState;
  enableRecovery(): () => void;
  discardRecovery(): Promise<void>;
  recoverSession(options: SessionImportOptions): Promise<boolean>;
  retryRecoveryOwnership(): Promise<void>;
  retryRecoverySaving(): void;
  showRecoveryOffer(visible: boolean): void;
  discardSession(): Promise<void>;
  switchInput(inputDeviceId: string): Promise<boolean>;
  exportSession(options?: SessionExportOptions): Promise<Blob>;
  importSession(file: Blob, options: SessionImportOptions): Promise<boolean>;
  setInputFx(config: FxConfig): void;
  setInputCutoff(cutoffHz: number): void;
  setInputBypass(bypassed: boolean): void;
  setPlaybackFx(scope: Exclude<FxScope, 0>, config: FxConfig): void;
  setPlaybackCutoff(scope: Exclude<FxScope, 0>, cutoffHz: number): void;
  setPlaybackBypass(scope: Exclude<FxScope, 0>, bypassed: boolean): void;
}

export type { FxCutoffAdjustment };
