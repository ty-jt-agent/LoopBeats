export {
  assembleSession,
  type ExportManifest,
} from '@loopbeats/session-format';

export interface ExportReply {
  type: 'export-reply';
  requestId: number;
  error?: string;
  manifest?: import('@loopbeats/session-format').ExportManifest;
  samples?: Float32Array;
  captureKinds?: import('./session-recovery').CheckpointInfo['captureKinds'];
  checkpointStartedAt?: number;
}
