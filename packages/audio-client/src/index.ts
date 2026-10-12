import type {
  FxConfig,
  SessionFxSnapshot,
  AudioCommand,
  AudioSnapshot,
  TrackSnapshot,
  TrackId,
  PlaybackMode,
  TransportSnapshot,
} from '@loopbeats/domain';
export type { AudioSnapshot } from '@loopbeats/domain';
import { assembleSession, type ExportReply } from './session-export';
import { parseSession } from './session-import';
import { convertSession } from './session-conversion';
import { SessionRecovery, type RecoveryState } from './session-recovery';
type ImportReply = {
  type: 'import-reply';
  requestId: number;
  error?: string;
  hasRecordings?: boolean;
};
type InputFxReply = {
  type: 'input-fx-reply';
  requestId: number;
  error?: string;
};

type Session = {
  context: AudioContext;
  source?: MediaStreamAudioSourceNode;
  interrupted?: boolean;
  recovering?: boolean;
  recoveryAfterFrames?: number;
  finishRecovery?: (error?: Error) => void;
  stream?: MediaStream;
  node?: AudioWorkletNode;
  interval?: ReturnType<typeof setInterval>;
  cancelStartup?: () => void;
  inputDeviceId?: string;
  preferredInputId?: string;
  switching?: boolean;
  switchToken?: number;
};
type WorkletSnapshot = {
  fx?: SessionFxSnapshot;
  recordingRevisions: number[];
  masterGain: number;
  type: 'snapshot';
  transport: TransportSnapshot;
  tracks: readonly [TrackSnapshot, TrackSnapshot];
  failed: boolean;
  monitoring: boolean;
  processedFrames: number;
  inputLevel: number;
  outputLevel: number;
};
const emptyTrack = (): TrackSnapshot => ({
  gain: 1,
  muted: false,
  state: 'Empty',
  mode: 'Loop',
  canSetMode: false,
  canSetLoop: false,
  lengthSamples: 0,
  positionSamples: 0,
  capacitySamples: 0,
  capturedSamples: 0,
  captureLimitSamples: 0,
  canRecord: false,
  canPlay: false,
  canStop: false,
});
const idle = (): AudioSnapshot => ({
  inputDeviceId: null,
  masterGain: 1,
  status: 'idle',
  transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
  tracks: [emptyTrack(), emptyTrack()],
  monitoring: false,
  error: null,
  sampleRate: null,
  processedFrames: 0,
  inputLevel: 0,
  outputLevel: 0,
});

function recovery(error: unknown, stage: string): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access was blocked. Allow microphone access in your browser site settings, then try Start audio again.';
  if (name === 'NotFoundError')
    return 'No audio input was found. Connect or enable a microphone/audio interface, then try Start audio again.';
  if (name === 'NotReadableError')
    return 'The audio input could not be opened. Check its connection and other applications using it, then retry.';
  if (stage === 'engine')
    return 'The audio engine could not initialize. Check your connection, rebuild audio assets with npm run build:audio if running locally, and try Start audio again.';
  return error instanceof Error
    ? `${error.message} Try Start audio again.`
    : 'Audio could not start. Check your input device and browser support, then retry.';
}

/** Dispatch result; engine snapshots remain the acknowledgement of removal. */
type DestructiveResult =
  | { status: 'sent' }
  | { status: 'stale' }
  | { status: 'failed'; error: string };

/** Owns browser audio resources; React consumes immutable engine/lifecycle snapshots. */
export class AudioClient {
  private fxSequence = 0;
  private fxFlight: {
    session: Session;
    requestId: number;
    config: FxConfig;
  } | null = null;
  private queuedFx: FxConfig | null = null;
  private snapshot = idle();
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private attempt = 0;
  private inputError: string | null = null;
  private exportSequence = 0;
  private cancelExport: (() => void) | null = null;
  private exportOwner: Session | null = null;
  private exportReply: ((reply: ExportReply) => void) | null = null;
  private cancelImport: (() => void) | null = null;
  private importOwner: Session | null = null;
  private importReply: ((reply: ImportReply) => void) | null = null;
  private recoverySession?: SessionRecovery;
  private recordingRevisions: number[] = [];
  private recoveryInitialization?: Promise<void>;
  private readonly noRecovery: RecoveryState = {
    status: 'Recovery disabled.',
    owner: false,
    offer: null,
    savedAt: null,
    error: null,
    offerVisible: true,
  };
  getRecoverySnapshot = (): RecoveryState =>
    this.recoverySession?.getSnapshot() ?? this.noRecovery;
  enableRecovery(): () => void {
    this.recoverySession ??= new SessionRecovery({
      snapshot: this.getSnapshot,
      available: () =>
        !this.cancelExport && !this.cancelImport && !this.session?.switching,
      checkpoint: async (signal) => {
        let progress: import('./session-recovery').CheckpointInfo | undefined;
        const archive = await this.captureSession(
          { signal },
          (captureKinds, startedAt) => {
            progress = { startedAt, captureKinds };
          },
        );
        if (!progress) throw new Error('Checkpoint metadata is unavailable.');
        return { archive, progress };
      },
      notify: () => {
        for (const listener of this.listeners) listener();
      },
    });
    this.recoveryInitialization = this.recoverySession.initialize();
    return () => this.recoverySession?.dispose();
  }
  async discardRecovery(): Promise<void> {
    await this.recoverySession?.discard();
  }
  async recoverSession(
    options: Parameters<AudioClient['importSession']>[1],
  ): Promise<boolean> {
    const archive = this.recoverySession?.archiveForRecovery();
    if (!archive) throw new Error('No valid recovery snapshot is available.');
    return this.restoreSession(archive, options, true);
  }
  async retryRecoveryOwnership(): Promise<void> {
    await this.recoverySession?.initialize();
  }
  retryRecoverySaving(): void {
    this.recoverySession?.retry();
  }
  showRecoveryOffer(visible: boolean): void {
    this.recoverySession?.showOffer(visible);
  }
  private async deletionBarrier(): Promise<void> {
    await this.recoveryInitialization;
    await this.recoverySession?.beforeDestructive();
  }
  constructor(private assets: { wasm: string; worklet: string }) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: AudioSnapshot) {
    this.snapshot = snapshot;
    this.recoverySession?.observe(snapshot, this.recordingRevisions);
    for (const listener of this.listeners) listener();
  }
  private disconnectInput(session: Session) {
    session.source?.disconnect();
    session.source = undefined;
    session.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
      track.stop();
    });
    session.stream = undefined;
  }
  private watchInput(session: Session) {
    for (const track of session.stream?.getAudioTracks() ?? []) {
      track.onended = () =>
        this.interrupt(session, 'Audio input disconnected.');
      track.onmute = () =>
        this.interrupt(session, 'Audio input was interrupted.');
    }
  }
  private poll(session: Session) {
    clearInterval(session.interval);
    session.interval = setInterval(() => {
      if (this.session === session)
        session.node?.port.postMessage({
          type: 'snapshot',
        } satisfies AudioCommand);
    }, 100);
  }
  private interrupt(session: Session, reason: string) {
    if (
      this.session !== session ||
      (session.interrupted && !session.recovering)
    )
      return;
    this.cancelExport?.();
    this.cancelImport?.();
    ++this.attempt;
    session.interrupted = true;
    session.recovering = false;
    session.finishRecovery?.(new Error(reason));
    clearInterval(session.interval);
    this.disconnectInput(session);
    session.node?.disconnect();
    session.node?.port.postMessage({
      type: 'interrupt',
    } satisfies AudioCommand);
    this.publish({
      ...this.snapshot,
      status: 'interrupted',
      error: `${reason} Completed recordings are retained. Reinitialize audio, then press PLAY when ready.`,
      monitoring: false,
      inputLevel: 0,
      outputLevel: 0,
    });
  }
  private async release(session: Session) {
    if (this.fxFlight?.session === session) {
      this.fxFlight = null;
      this.queuedFx = null;
    }
    if (this.exportOwner === session) this.cancelExport?.();
    if (this.importOwner === session) this.cancelImport?.();
    clearInterval(session.interval);
    session.cancelStartup?.();
    session.finishRecovery?.(new Error('Audio recovery canceled'));
    session.context.onstatechange = null;
    this.disconnectInput(session);
    session.node?.disconnect();
    if (session.node) {
      session.node.onprocessorerror = null;
      session.node.port.onmessage = null;
      session.node.port.close();
    }
    if (session.context.state !== 'closed')
      await session.context.close().catch(() => {});
  }
  private async fail(session: Session, message: string) {
    if (this.session !== session) return;
    this.session = null;
    this.attempt++;
    this.publish({ ...idle(), status: 'error', error: message });
    await this.release(session);
  }
  async start(inputDeviceId?: string): Promise<void> {
    if (
      this.snapshot.status === 'starting' ||
      this.snapshot.status === 'ready' ||
      this.snapshot.status === 'stopping' ||
      this.snapshot.status === 'interrupted' ||
      this.snapshot.status === 'recovering'
    )
      return;
    const attempt = ++this.attempt;
    this.inputError = null;
    this.publish({ ...idle(), status: 'starting' });
    let session: Session | undefined;
    let stage = 'context';
    try {
      if (!globalThis.isSecureContext)
        throw new Error(
          'Microphone capture requires HTTPS or localhost. Open a secure URL.',
        );
      if (!globalThis.AudioContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(
          'This browser does not support the required audio APIs. Use desktop Chrome for this milestone.',
        );
      // Create/resume directly from the user's event; never during React render/effect.
      session = { context: new AudioContext({ latencyHint: 'interactive' }) };
      this.session = session;
      await session.context.resume();
      stage = 'input';
      if (attempt !== this.attempt) return;
      const audio = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
      } satisfies MediaTrackConstraints;
      try {
        session.stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (error) {
        if (
          !inputDeviceId ||
          !['NotFoundError', 'OverconstrainedError'].includes(
            error instanceof DOMException ? error.name : '',
          )
        )
          throw error;
        session.stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...audio, deviceId: undefined },
        });
      }
      session.inputDeviceId =
        session.stream.getAudioTracks()[0]?.getSettings().deviceId || undefined;
      session.preferredInputId = inputDeviceId;
      if (attempt !== this.attempt) {
        await this.release(session);
        return;
      }
      stage = 'engine';
      const response = await fetch(this.assets.wasm);
      if (!response.ok) throw new Error('Audio engine download failed');
      const module = await WebAssembly.compile(await response.arrayBuffer());
      if (attempt !== this.attempt) return;
      await session.context.audioWorklet.addModule(this.assets.worklet);
      if (attempt !== this.attempt) return;
      const node = new AudioWorkletNode(session.context, 'loop-engine', {
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [2],
        processorOptions: { module },
      });
      session.node = node;
      const current = session;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Worklet initialization timed out')),
          5000,
        );
        const finish = () => {
          clearTimeout(timeout);
          resolve();
        };
        current.cancelStartup = finish;
        node.onprocessorerror = () => {
          clearTimeout(timeout);
          reject(new Error('Audio processor failed'));
          void this.fail(
            current,
            'The audio processor stopped. Try Start audio again to create a new session.',
          );
        };
        node.port.onmessage = ({
          data,
        }: MessageEvent<
          WorkletSnapshot | ExportReply | ImportReply | InputFxReply
        >) => {
          if (data.type === 'input-fx-reply') {
            if (
              this.session === current &&
              this.fxFlight?.session === current &&
              this.fxFlight.requestId === data.requestId
            ) {
              this.fxFlight = null;
              const queued = this.queuedFx;
              this.queuedFx = null;
              this.publish({
                ...this.snapshot,
                inputFxPending: false,
                inputFxError: data.error ?? null,
              });
              // Busy removal is rejected, never deferred to a later engine state.
              if (queued && !data.error) this.setInputFx(queued);
            }
            return;
          }
          if (data.type === 'import-reply') {
            if (this.session === current) this.importReply?.(data);
            return;
          }
          if (data.type === 'export-reply') {
            if (this.session === current) this.exportReply?.(data);
            return;
          }
          if (this.session !== current) {
            finish();
            return;
          }
          if (data.failed) {
            clearTimeout(timeout);
            reject(new Error('Audio processing capacity exceeded'));
            void this.fail(
              current,
              'Audio processing stopped. Try Start audio again; if this repeats, use desktop Chrome and report the failure.',
            );
            return;
          }
          if (data.processedFrames > 0) {
            this.recordingRevisions = data.recordingRevisions;
            const recovered =
              current.recovering &&
              current.recoveryAfterFrames !== undefined &&
              data.processedFrames > current.recoveryAfterFrames;
            if (recovered) {
              current.recovering = false;
              current.interrupted = false;
            }
            this.publish({
              fx: data.fx,
              inputFxPending: Boolean(this.fxFlight),
              inputFxError: this.snapshot.inputFxError ?? null,
              status: current.recovering
                ? 'recovering'
                : current.interrupted
                  ? 'interrupted'
                  : 'ready',
              inputDeviceId: current.inputDeviceId ?? null,
              error: current.interrupted
                ? this.snapshot.error
                : this.inputError,
              monitoring: data.monitoring,
              sampleRate: current.context.sampleRate,
              processedFrames: data.processedFrames,
              inputLevel: current.interrupted ? 0 : data.inputLevel,
              outputLevel: current.interrupted ? 0 : data.outputLevel,
              tracks: data.tracks,
              masterGain: data.masterGain,
              transport: data.transport,
            });
            if (recovered) current.finishRecovery?.();
            finish();
          }
        };
        current.source = current.context.createMediaStreamSource(
          current.stream!,
        );
        current.source.connect(node).connect(current.context.destination);
        // Polling observes state only; it never schedules sample-level operations.
        this.poll(current);
      });
      if (attempt !== this.attempt) return;
      this.watchInput(current);
      current.context.onstatechange = () => {
        if (this.session === current && current.context.state !== 'running')
          this.interrupt(current, 'Audio context was interrupted.');
      };
    } catch (error) {
      if (attempt !== this.attempt) return;
      if (session) {
        this.session = null;
        await this.release(session);
      }
      if (attempt !== this.attempt) return;
      this.publish({
        ...idle(),
        status: 'error',
        error: recovery(error, stage),
      });
    }
  }
  async switchInput(inputDeviceId: string): Promise<boolean> {
    const session = this.session;
    if (
      this.snapshot.status !== 'ready' ||
      !session?.node ||
      !session.stream ||
      session.switching
    )
      return false;
    const active = this.snapshot.tracks.some((track) =>
      ['Recording', 'Playing', 'Overdubbing'].includes(track.state),
    );
    if (active || this.snapshot.transport.running) return false;
    session.switching = true;
    this.cancelExport?.();
    this.cancelImport?.();
    const switchToken = (session.switchToken ?? 0) + 1;
    session.switchToken = switchToken;
    const attempt = this.attempt;
    let replacement: MediaStream | undefined;
    try {
      const audio = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
      } satisfies MediaTrackConstraints;
      replacement = await navigator.mediaDevices.getUserMedia({ audio });
      if (
        this.session !== session ||
        attempt !== this.attempt ||
        this.snapshot.status !== 'ready' ||
        session.context.state === 'closed' ||
        session.interrupted ||
        session.recovering ||
        this.snapshot.tracks.some((track) =>
          ['Recording', 'Playing', 'Overdubbing'].includes(track.state),
        ) ||
        this.snapshot.transport.running
      ) {
        replacement.getTracks().forEach((track) => track.stop());
        return false;
      }
      const source = session.context.createMediaStreamSource(replacement);
      source.connect(session.node);
      session.source?.disconnect();
      session.stream.getTracks().forEach((track) => {
        track.onended = null;
        track.onmute = null;
        track.stop();
      });
      session.stream = replacement;
      session.source = source;
      session.inputDeviceId =
        replacement.getAudioTracks()[0]?.getSettings().deviceId || undefined;
      session.preferredInputId = inputDeviceId;
      this.watchInput(session);
      this.inputError = null;
      this.stopTransport();
      return true;
    } catch (error) {
      if (replacement) replacement.getTracks().forEach((track) => track.stop());
      if (this.session === session && attempt === this.attempt) {
        this.inputError = recovery(error, 'input');
        this.publish({ ...this.snapshot, error: this.inputError });
      }
      return false;
    } finally {
      if (session.switchToken === switchToken) session.switching = false;
    }
  }
  /** Reconnect live input explicitly while retaining the initialized in-memory engine. */
  async reinitialize(): Promise<void> {
    const session = this.session;
    if (!session?.node || this.snapshot.status !== 'interrupted') return;
    const attempt = ++this.attempt;
    session.recovering = true;
    session.recoveryAfterFrames = undefined;
    this.publish({ ...this.snapshot, status: 'recovering' });
    try {
      if (session.context.state === 'closed')
        throw new Error(
          'The audio context is closed and cannot resume. Stop audio discards this session so a new one can be started.',
        );
      // Resume occurs directly from this explicit user action.
      await session.context.resume();
      if (attempt !== this.attempt) return;
      if (session.context.state !== 'running')
        throw new Error(
          'The browser is still interrupting audio. Release the other audio application and retry.',
        );
      const preferredInputId = session.preferredInputId;
      const audio = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(preferredInputId ? { deviceId: { exact: preferredInputId } } : {}),
      } satisfies MediaTrackConstraints;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (error) {
        if (
          !preferredInputId ||
          !['NotFoundError', 'OverconstrainedError'].includes(
            error instanceof DOMException ? error.name : '',
          )
        )
          throw error;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...audio, deviceId: undefined },
        });
      }
      if (attempt !== this.attempt || this.session !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;
      session.inputDeviceId =
        stream.getAudioTracks()[0]?.getSettings().deviceId || undefined;
      this.inputError = null;
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live'))
        throw new Error('The audio input is no longer available.');
      this.watchInput(session);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Audio recovery timed out')),
          5000,
        );
        session.finishRecovery = (error) => {
          clearTimeout(timeout);
          session.finishRecovery = undefined;
          if (error) reject(error);
          else resolve();
        };
        session.recoveryAfterFrames = this.snapshot.processedFrames;
        session.source = session.context.createMediaStreamSource(stream);
        session.source
          .connect(session.node!)
          .connect(session.context.destination);
        this.poll(session);
      });
    } catch (error) {
      if (attempt !== this.attempt || this.session !== session) return;
      session.recovering = false;
      session.interrupted = true;
      session.finishRecovery?.();
      clearInterval(session.interval);
      this.disconnectInput(session);
      session.node.disconnect();
      this.publish({
        ...this.snapshot,
        status: 'interrupted',
        error: `${error instanceof Error ? error.message : 'Audio recovery failed.'} Completed recordings are retained; retry Reinitialize audio.`,
        monitoring: false,
        inputLevel: 0,
        outputLevel: 0,
      });
    }
  }
  setMonitoring(enabled: boolean): void {
    if (this.snapshot.status === 'ready')
      this.session?.node?.port.postMessage({
        type: 'monitoring',
        enabled,
      } satisfies AudioCommand);
  }
  /** Downloadable completed-session archive; no browser infrastructure escapes this client. */
  async exportSession(
    options: {
      signal?: AbortSignal;
      onProgress?: (fraction: number) => void;
    } = {},
  ): Promise<Blob> {
    await this.recoverySession?.yieldToUser();
    return this.captureSession(options);
  }
  private async captureSession(
    options: {
      signal?: AbortSignal;
      onProgress?: (fraction: number) => void;
    } = {},
    checkpoint?: (
      kinds: NonNullable<ExportReply['captureKinds']>,
      startedAt: number,
    ) => void,
  ): Promise<Blob> {
    const session = this.session;
    if (this.snapshot.status !== 'ready' || !session?.node || session.switching)
      throw new Error('Start audio before exporting.');
    if (this.cancelExport || this.cancelImport)
      throw new Error('A session operation is already in progress.');
    const port = session.node.port;
    const token = ++this.exportSequence;
    let canceled = false;
    let rejectRequest: ((error: Error) => void) | undefined;
    const sendCancellation = () => {
      try {
        port.postMessage({
          type: checkpoint ? 'checkpoint-cancel' : 'export-cancel',
          token,
        });
      } catch {
        // A failed browser port must not prevent local rejection or cleanup.
      }
    };
    const cancel = () => {
      canceled = true;
      sendCancellation();
      rejectRequest?.(new Error('Export canceled.'));
    };
    this.cancelExport = cancel;
    this.exportOwner = session;
    const check = () => {
      if (
        canceled ||
        options.signal?.aborted ||
        this.session !== session ||
        this.snapshot.status !== 'ready'
      )
        throw new Error('Export canceled.');
    };
    const request = (
      type: string,
      fields: Record<string, number> = {},
      requestId = ++this.exportSequence,
    ) => {
      check();
      return new Promise<ExportReply>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error('Export transfer timed out. Try again.')),
          30000,
        );
        const finish = (error?: Error, reply?: ExportReply) => {
          clearTimeout(timer);
          this.exportReply = null;
          rejectRequest = undefined;
          if (error) reject(error);
          else resolve(reply!);
        };
        rejectRequest = (error) => finish(error);
        this.exportReply = (reply) => {
          if (reply.requestId === requestId)
            finish(reply.error ? new Error(reply.error) : undefined, reply);
        };
        try {
          port.postMessage({
            type: checkpoint ? type.replace('export-', 'checkpoint-') : type,
            token,
            requestId,
            ...fields,
          });
        } catch {
          finish(new Error('Export transfer failed. Try again.'));
        }
      });
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const start = await request('export-begin', {}, token);
      if (!start.manifest) throw new Error('Export metadata is unavailable.');
      if (checkpoint) {
        if (
          !start.captureKinds ||
          !Number.isSafeInteger(start.checkpointStartedAt)
        )
          throw new Error('Checkpoint metadata is unavailable.');
        checkpoint(start.captureKinds, start.checkpointStartedAt!);
      }
      const blob = await assembleSession(
        start.manifest,
        async (trackId, offset, frames) => {
          const reply = await request('export-read', {
            trackId,
            offset,
            frames,
          });
          if (!reply.samples) throw new Error('Export audio is unavailable.');
          return reply.samples;
        },
        check,
        options.onProgress ?? (() => {}),
      );
      await request('export-finish');
      check();
      return blob;
    } catch (error) {
      if (
        error instanceof RangeError ||
        (error instanceof DOMException && error.name === 'QuotaExceededError')
      )
        throw new Error(
          'Not enough memory to export this session. Free memory or export shorter recordings, then try again. Your recordings are unchanged.',
          { cause: error },
        );
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      this.cancelExport = null;
      this.exportOwner = null;
      this.exportReply = null;
      sendCancellation();
    }
  }
  /** Validate/stage first; the worklet atomically installs both tracks on commit. */
  async importSession(
    file: Blob,
    options: {
      signal?: AbortSignal;
      onProgress?: (fraction: number) => void;
      onCommitting?: () => void;
      confirmReplace: (signal: AbortSignal) => Promise<boolean>;
      confirmConversion?: (
        sourceRate: number,
        targetRate: number,
        signal: AbortSignal,
      ) => Promise<boolean>;
    },
  ): Promise<boolean> {
    return this.restoreSession(file, options);
  }
  private async restoreSession(
    file: Blob,
    options: Parameters<AudioClient['importSession']>[1],
    retainRecovery = false,
  ): Promise<boolean> {
    await this.recoverySession?.yieldToUser();
    const session = this.session;
    if (this.snapshot.status !== 'ready' || !session?.node || session.switching)
      throw new Error('Start audio before importing.');
    if (this.cancelExport || this.cancelImport)
      throw new Error('A session operation is already in progress.');
    if (
      this.snapshot.tracks.some((t) =>
        ['Recording', 'Overdubbing'].includes(t.state),
      )
    )
      throw new Error('Finish recording before importing.');
    if (file.size > 96 * 1024 * 1024)
      throw new Error('Session ZIP exceeds 96 MiB.');
    const port = session.node.port,
      token = ++this.exportSequence;
    let canceled = false,
      committing = false;
    const cancellation = new AbortController();
    let rejectWait: (() => void) | undefined;
    let rejectRequest: ((error: Error) => void) | undefined;
    const sendCancellation = () => {
      try {
        port.postMessage({ type: 'import-cancel', token });
      } catch {
        /* Cleanup must survive port failure. */
      }
    };
    const cancel = (force = false) => {
      if (committing && !force) return;
      canceled = true;
      cancellation.abort();
      rejectWait?.();
      sendCancellation();
      rejectRequest?.(new Error('Import canceled.'));
    };
    this.cancelImport = () => cancel(true);
    this.importOwner = session;
    const check = () => {
      if (
        canceled ||
        options.signal?.aborted ||
        this.session !== session ||
        this.snapshot.status !== 'ready' ||
        session.switching
      )
        throw new Error('Import canceled.');
    };
    const request = (
      type: string,
      fields: Record<string, unknown> = {},
      requestId = ++this.exportSequence,
    ) => {
      check();
      return new Promise<ImportReply>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error('Import transfer timed out. Try again.')),
          30000,
        );
        const finish = (error?: Error, reply?: ImportReply) => {
          clearTimeout(timer);
          this.importReply = null;
          rejectRequest = undefined;
          if (error) reject(error);
          else resolve(reply!);
        };
        rejectRequest = (error) => finish(error);
        this.importReply = (reply) => {
          if (reply.requestId === requestId)
            finish(reply.error ? new Error(reply.error) : undefined, reply);
        };
        try {
          port.postMessage({ type, token, requestId, ...fields });
        } catch {
          finish(new Error('Import transfer failed. Try again.'));
        }
      });
    };
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      check();
      const canceledWait = new Promise<T>((_, reject) => {
        rejectWait = () => reject(new Error('Import canceled.'));
      });
      try {
        return await Promise.race([promise, canceledWait]);
      } finally {
        rejectWait = undefined;
      }
    };
    const abort = () => cancel();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const start = await request('import-begin', {}, token);
      const parsed = await parseSession(
        await wait(file.arrayBuffer()),
        session.context.sampleRate,
        check,
        true,
      );
      let importSource = {
        manifest: parsed.manifest,
        read: async (id: number, offset: number, frames: number) =>
          parsed.read(id, offset, frames),
      };
      if (parsed.manifest.sampleRate !== session.context.sampleRate) {
        const planned = convertSession(
          parsed,
          session.context.sampleRate,
          check,
        );
        if (!options.confirmConversion)
          throw new Error(
            'Sample-rate conversion needs explicit confirmation. Your recordings are unchanged.',
          );
        const accepted = await wait(
          options.confirmConversion(
            parsed.manifest.sampleRate,
            session.context.sampleRate,
            cancellation.signal,
          ),
        );
        check();
        if (!accepted) return false;
        importSource = planned;
      }
      await request('import-configure', { manifest: importSource.manifest });
      const total = importSource.manifest.tracks.reduce(
        (sum, t) => sum + t.lengthSamples,
        0,
      );
      let copied = 0;
      for (const track of importSource.manifest.tracks) {
        for (let offset = 0; offset < track.lengthSamples; offset += 2048) {
          const samples = await importSource.read(
            track.id,
            offset,
            Math.min(2048, track.lengthSamples - offset),
          );
          await request('import-write', { trackId: track.id, offset, samples });
          copied += samples.length;
          options.onProgress?.(total ? copied / total : 1);
        }
      }
      check();
      if (start.hasRecordings) {
        const confirmed = await wait(
          options.confirmReplace(cancellation.signal),
        );
        if (!confirmed) {
          check();
          return false;
        }
      }
      check();
      if (!retainRecovery) await this.deletionBarrier();
      else this.recoverySession?.requireOwner();
      check();
      options.onCommitting?.();
      // Commit is the linearization point. Cancellation is available until dispatch.
      const committed = request('import-commit');
      committing = true;
      await committed;
      if (
        this.session !== session ||
        this.snapshot.status !== 'ready' ||
        session.switching
      )
        throw new Error(
          'Import interrupted. Reinitialize audio before retrying.',
        );
      if (retainRecovery) this.recoverySession?.recovered();
      return true;
    } catch (error) {
      if (
        error instanceof RangeError ||
        (error instanceof DOMException && error.name === 'QuotaExceededError')
      )
        throw new Error(
          'Not enough memory to import this session. Free memory and retry. Your recordings are unchanged.',
          { cause: error },
        );
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.cancelImport = null;
      this.importOwner = null;
      this.importReply = null;
      rejectWait = undefined;
      cancellation.abort();
      sendCancellation();
    }
  }
  private command(command: AudioCommand): void {
    if (command.type === 'reset' || command.type === 'stop-transport')
      this.queuedFx = null;
    if (this.snapshot.status === 'ready')
      this.session?.node?.port.postMessage(command);
  }
  setInputFx(config: FxConfig): void {
    const session = this.session;
    if (this.snapshot.status !== 'ready' || !session?.node || session.switching)
      return;
    if (
      this.snapshot.fx?.[0].removing ||
      this.fxFlight?.config.type === 'None'
    ) {
      this.publish({
        ...this.snapshot,
        inputFxError:
          'Input FX is being removed. Try again after the transition.',
      });
      return;
    }
    if (this.fxFlight) {
      this.queuedFx = config;
      return;
    }
    const requestId = ++this.fxSequence;
    this.fxFlight = { session, requestId, config };
    this.publish({
      ...this.snapshot,
      inputFxPending: true,
      inputFxError: null,
    });
    session.node.port.postMessage({ type: 'set-input-fx', requestId, config });
  }
  private desiredInputFx(): FxConfig | undefined {
    return (
      this.queuedFx ?? this.fxFlight?.config ?? this.snapshot.fx?.[0].config
    );
  }
  setInputCutoff(cutoffHz: number): void {
    const config = this.desiredInputFx();
    if (config?.type === 'LowPass') this.setInputFx({ ...config, cutoffHz });
  }
  setInputBypass(bypassed: boolean): void {
    const config = this.desiredInputFx();
    if (config?.type === 'LowPass') this.setInputFx({ ...config, bypassed });
  }
  async clear(trackId: TrackId): Promise<DestructiveResult> {
    return this.destructiveAction(() =>
      this.command({ type: 'clear', trackId }),
    );
  }
  async reset(): Promise<DestructiveResult> {
    return this.destructiveAction(() => this.command({ type: 'reset' }));
  }
  setTrackGain(trackId: TrackId, gain: number): void {
    this.command({ type: 'set-track-gain', trackId, gain });
  }
  setTrackMute(trackId: TrackId, muted: boolean): void {
    this.command({ type: 'set-track-mute', trackId, muted });
  }
  setMasterGain(gain: number): void {
    this.command({ type: 'set-master-gain', gain });
  }
  setMode(trackId: TrackId, mode: PlaybackMode): void {
    this.command({ type: 'set-mode', trackId, mode });
  }
  record(trackId: TrackId): void {
    this.command({ type: 'record', trackId });
  }
  play(trackId: TrackId): void {
    this.command({ type: 'play', trackId });
  }
  stopTrack(trackId: TrackId): void {
    this.command({ type: 'stop-track', trackId });
  }
  stopTransport(): void {
    if (this.snapshot.tracks.some((track) => track.state === 'Recording')) {
      void this.destructiveAction(() =>
        this.command({ type: 'stop-transport' }),
      );
    } else this.command({ type: 'stop-transport' });
  }
  startTracks(): void {
    this.command({ type: 'start-tracks' });
  }
  async discardSession(): Promise<void> {
    await this.destructiveAction(() => this.stop());
  }
  private async destructiveAction(
    action: () => void | Promise<void>,
  ): Promise<DestructiveResult> {
    const session = this.session,
      attempt = this.attempt;
    try {
      await this.deletionBarrier();
      if (session !== this.session || attempt !== this.attempt)
        return { status: 'stale' };
      await action();
      return { status: 'sent' };
    } catch (error) {
      this.recoverySession?.report(error);
      return {
        status: 'failed',
        error:
          error instanceof Error ? error.message : 'Recovery deletion failed.',
      };
    }
  }
  async stop(): Promise<void> {
    const attempt = ++this.attempt;
    const session = this.session;
    this.session = null;
    this.publish({ ...idle(), status: 'stopping' });
    if (session) await this.release(session);
    if (attempt === this.attempt) this.publish(idle());
  }
}
