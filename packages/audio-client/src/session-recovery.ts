import type { AudioSnapshot } from '@loopbeats/domain';

const NAME = 'loopbeats.recovery.v1';
const CAPTURE_KINDS = [
  'FirstLoop',
  'JoinedLoop',
  'OneShot',
  'Overdub',
] as const;
type CaptureKind = (typeof CAPTURE_KINDS)[number];
export type CheckpointInfo = {
  startedAt: number;
  captureKinds: (null | CaptureKind)[];
};
export type RecoveryRecord = {
  version: 1;
  savedAt: number;
  revision: number;
  archive: Blob;
  progress?: CheckpointInfo;
};
export type RecoveryState = {
  /** Presentation of an existing failure; does not change recovery policy. */
  failureKind?: 'initialization' | 'saving' | 'deletion' | 'operation';
  frozenAt?: number | null;
  invalidRecord?: boolean;
  /** Observations of existing ownership/read barriers, not a second policy. */
  savingPaused?: boolean;
  available?: boolean;
  status: string;
  owner: boolean;
  offer: Pick<RecoveryRecord, 'savedAt' | 'revision' | 'progress'> | null;
  savedAt: number | null;
  error: string | null;
  offerVisible: boolean;
};
type Host = {
  snapshot(): AudioSnapshot;
  checkpoint(
    signal: AbortSignal,
  ): Promise<{ archive: Blob; progress: CheckpointInfo }>;
  available(): boolean;
  notify(): void;
};

/** Atomic single-record storage. Cancellation aborts an open transaction. */
export class RecoveryStorage {
  private async open(signal?: AbortSignal): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 1);
      let settled = false;
      const finish = (
        error?: Error | DOMException | null,
        db?: IDBDatabase,
      ) => {
        if (settled) {
          db?.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (db) resolve(db);
        else reject(error ?? new Error('Recovery storage failed.'));
      };
      const abort = () => finish(new Error('Recovery canceled.'));
      const timer = setTimeout(
        () => finish(new Error('Recovery storage timed out. Retry saving.')),
        10000,
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      request.onupgradeneeded = () =>
        request.result.createObjectStore('snapshot');
      request.onerror = () => finish(request.error);
      request.onblocked = () =>
        finish(new Error('Recovery storage is blocked by another tab.'));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish(undefined, request.result);
      };
    });
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const db = await this.open(signal);
    try {
      if (signal?.aborted) throw new Error('Recovery canceled.');
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction('snapshot', mode);
        const request = action(transaction.objectStore('snapshot'));
        const abort = () => {
          try {
            transaction.abort();
          } catch {
            /* Already completed. */
          }
        };
        signal?.addEventListener('abort', abort, { once: true });
        const finish = () => signal?.removeEventListener('abort', abort);
        transaction.oncomplete = () => {
          finish();
          resolve(request.result);
        };
        transaction.onabort = () => {
          finish();
          reject(transaction.error ?? new Error('Recovery write canceled.'));
        };
        transaction.onerror = () => {}; // The abort event is the transaction result.
      });
    } finally {
      db.close();
    }
  }
  async read(): Promise<RecoveryRecord | null> {
    const record: unknown = await this.transaction('readonly', (store) =>
      store.get('latest'),
    );
    if (record === undefined) return null;
    const value = record as RecoveryRecord;
    if (
      !value ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.savedAt) ||
      value.savedAt < 0 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !(value.archive instanceof Blob) ||
      (value.progress !== undefined &&
        (!value.progress ||
          Object.keys(value.progress).length !== 2 ||
          !Number.isSafeInteger(value.progress.startedAt) ||
          value.progress.startedAt < 0 ||
          value.progress.startedAt > value.savedAt ||
          !Array.isArray(value.progress.captureKinds) ||
          value.progress.captureKinds.length !== 2 ||
          Object.keys(value.progress.captureKinds).join(',') !== '0,1' ||
          value.progress.captureKinds.some(
            (kind) => kind !== null && !CAPTURE_KINDS.includes(kind),
          ))) ||
      value.archive.size > 96 * 1024 * 1024
    )
      throw new Error(
        'Invalid or unsupported recovery snapshot. Discard it to resume saving.',
      );
    return value;
  }
  async write(record: RecoveryRecord, signal: AbortSignal): Promise<void> {
    await this.transaction(
      'readwrite',
      (store) => store.put(record, 'latest'),
      signal,
    );
  }
  async delete(): Promise<void> {
    await this.transaction('readwrite', (store) => store.delete('latest'));
  }
}

/** Owns checkpoint cadence, ownership and deletion barriers outside audio processing. */
export class SessionRecovery {
  private state: RecoveryState = {
    status: 'Checking recovery…',
    owner: false,
    offer: null,
    savedAt: null,
    error: null,
    offerVisible: true,
  };
  private releaseLock?: () => void;
  private lifetime = 0;
  private epoch = 0;
  private revision = 0;
  private key = '';
  private dirty = false;
  private firstDirty = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private operation?: AbortController;
  private task: Promise<void> = Promise.resolve();
  private deletionTask: Promise<void> = Promise.resolve();
  private releasing: Promise<void> = Promise.resolve();
  private barrier = false;
  private disabled = false;
  private unresolved = true;
  private retryAfter = 0;
  private progressDue = 0;
  private offeredRecord: RecoveryRecord | null = null;
  constructor(
    private host: Host,
    private storage: Pick<
      RecoveryStorage,
      'read' | 'write' | 'delete'
    > = new RecoveryStorage(),
  ) {}
  getSnapshot = () => this.state;
  private publish(update: Partial<RecoveryState>) {
    this.state = {
      ...this.state,
      ...update,
      savingPaused: this.unresolved,
      available: !this.disabled,
    };
    this.host.notify();
  }
  async initialize(): Promise<void> {
    const requestedLifetime = this.lifetime;
    await this.releasing;
    if (requestedLifetime !== this.lifetime) return;
    if (this.state.owner || this.releaseLock) return;
    const lifetime = ++this.lifetime;
    this.unresolved = true;
    if (!globalThis.indexedDB || !navigator.locks) {
      this.disabled = true;
      this.publish({
        status: 'Recovery unavailable in this browser.',
        error: 'Use Save ZIP for a portable backup.',
      });
      return;
    }
    await new Promise<void>((resolve) => {
      void navigator.locks
        .request(NAME, { ifAvailable: true }, async (lock) => {
          if (lifetime !== this.lifetime) {
            resolve();
            return;
          }
          if (!lock) {
            this.publish({
              owner: false,
              status: 'Recovery paused: another tab owns it.',
            });
            resolve();
            return;
          }
          let release!: () => void;
          const held = new Promise<void>((finish) => {
            release = finish;
          });
          this.releaseLock = release;
          this.offeredRecord = null;
          this.publish({
            owner: true,
            offer: null,
            status: 'Checking recovery…',
          });
          try {
            const record = await this.storage.read();
            if (lifetime !== this.lifetime) {
              release();
              resolve();
              return;
            }
            this.unresolved = Boolean(record);
            this.offeredRecord = record;
            this.revision = record?.revision ?? 0;
            this.publish({
              offer: record
                ? {
                    savedAt: record.savedAt,
                    revision: record.revision,
                    progress: record.progress,
                  }
                : null,
              offerVisible: true,
              savedAt: record?.savedAt ?? null,
              frozenAt: record?.progress?.startedAt ?? null,
              failureKind: undefined,
              invalidRecord: false,
              error: null,
              status: record
                ? 'Recovery available.'
                : 'No recovery snapshot yet.',
            });
            this.key = '';
            this.observe(this.host.snapshot(), []);
          } catch (error) {
            this.unresolved = true;
            this.publish({
              invalidRecord:
                error instanceof Error &&
                error.message.startsWith('Invalid or unsupported'),
            });
            this.fail(error, 'initialization');
          }
          resolve();
          await held;
        })
        .catch((error) => {
          this.disabled = true;
          this.fail(error, 'initialization');
          resolve();
        });
    });
  }
  dispose(): void {
    this.lifetime++;
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.operation?.abort();
    const release = this.releaseLock;
    this.releaseLock = undefined;
    // Finish/abort a pending transaction before transferring ownership.
    this.releasing = Promise.allSettled([this.task, this.deletionTask]).then(
      () => {
        release?.();
      },
    );
    this.publish({ owner: false, status: 'Recovery paused.' });
  }
  observe(snapshot: AudioSnapshot, revisions: readonly number[]): void {
    if (snapshot.status !== 'ready') {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.operation?.abort();
      return;
    }
    const active = snapshot.tracks.some(
      (t) => t.state === 'Recording' || t.state === 'Overdubbing',
    );
    if (active && !this.progressDue) this.progressDue = Date.now() + 5000;
    if (!active && this.progressDue) {
      this.progressDue = 0;
      this.markDirty();
    }
    const key = JSON.stringify([
      snapshot.sampleRate,
      snapshot.masterGain,
      snapshot.transport.cycleLengthSamples,
      snapshot.tracks.map((t, id) => [
        t.mode,
        t.gain,
        t.muted,
        t.state === 'Recording' ? 0 : t.lengthSamples,
        revisions[id] ?? 0,
        t.state === 'Recording' || t.state === 'Overdubbing',
      ]),
    ]);
    if (key !== this.key) {
      this.key = key;
      this.markDirty();
    }
    this.schedule();
  }
  private markDirty(): void {
    if (!this.dirty) this.firstDirty = Date.now();
    this.dirty = true;
    if (this.state.owner && !this.unresolved)
      this.publish({ status: 'Changes not yet saved.' });
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(delay?: number): void {
    if (
      (!this.dirty && !this.progressDue) ||
      this.timer ||
      this.operation ||
      this.barrier ||
      !this.state.owner ||
      this.unresolved ||
      !this.host.available() ||
      this.host.snapshot().status !== 'ready'
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.host.available()) return;
        this.task = this.save();
      },
      Math.max(
        this.retryAfter - Date.now(),
        delay ??
          (this.progressDue
            ? Math.max(0, this.progressDue - Date.now())
            : Math.max(0, Math.min(1000, this.firstDirty + 5000 - Date.now()))),
      ),
    );
  }
  private fail(
    error: unknown,
    failureKind: RecoveryState['failureKind'],
  ): void {
    this.publish({
      failureKind,
      status: 'Recovery saving failed.',
      error:
        error instanceof Error
          ? error.message
          : 'Recovery storage failed. Use Save ZIP and retry.',
    });
  }
  private async save(): Promise<void> {
    const epoch = this.epoch;
    const controller = new AbortController();
    this.operation = controller;
    this.dirty = false;
    this.publish({ status: 'Saving…', error: null, failureKind: undefined });
    let failed = false;
    try {
      const { archive, progress } = await this.host.checkpoint(
        controller.signal,
      );
      if (this.progressDue) this.progressDue = progress.startedAt + 5000;
      if (
        controller.signal.aborted ||
        epoch !== this.epoch ||
        !this.state.owner
      )
        return;
      const record: RecoveryRecord = {
        version: 1,
        savedAt: Date.now(),
        revision: this.revision + 1,
        archive,
        progress,
      };
      await this.storage.write(record, controller.signal);
      if (epoch !== this.epoch) return;
      this.revision = record.revision;
      this.retryAfter = 0;
      this.publish({
        savedAt: record.savedAt,
        frozenAt: progress.startedAt,
        status: this.dirty
          ? 'Changes not yet saved.'
          : `Saved at ${new Date(record.savedAt).toLocaleString()}. Audio frozen at ${new Date(progress.startedAt).toLocaleString()}.`,
      });
    } catch (error) {
      this.dirty = true;
      if (!controller.signal.aborted) {
        failed = true;
        this.retryAfter = Date.now() + 30000;
        this.fail(error, 'saving');
      }
    } finally {
      this.operation = undefined;
      this.schedule(failed ? 30000 : undefined);
    }
  }
  retry(): void {
    this.retryAfter = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule(0);
  }
  report(error: unknown): void {
    this.fail(
      error,
      this.state.failureKind === 'deletion' ? 'deletion' : 'operation',
    );
  }
  /** Explicit operations cancel automatic transfer before acquiring AudioClient's operation slot. */
  async yieldToUser(): Promise<void> {
    this.operation?.abort();
    await this.task;
  }
  async beforeDestructive(discardOffer = false): Promise<void> {
    // Other tabs and a pending prior workspace must keep their saved snapshot.
    if (
      this.disabled ||
      !this.state.owner ||
      (this.unresolved && !discardOffer)
    )
      return;
    if (this.barrier)
      throw new Error('A recovery deletion is already in progress.');
    this.barrier = true;
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.operation?.abort();
    this.deletionTask = this.deleteAfterSave();
    return this.deletionTask;
  }
  private async deleteAfterSave(): Promise<void> {
    try {
      await this.task;
      await this.storage.delete();
      this.unresolved = false;
      this.offeredRecord = null;
      this.dirty = false;
      this.key = '';
      this.publish({
        offer: null,
        savedAt: null,
        frozenAt: null,
        failureKind: undefined,
        invalidRecord: false,
        status: 'No recovery snapshot yet.',
        error: null,
      });
    } catch (error) {
      this.fail(error, 'deletion');
      throw error;
    } finally {
      this.barrier = false;
    }
  }
  async discard(): Promise<void> {
    this.requireOwner();
    await this.beforeDestructive(true);
    this.markDirty();
    this.schedule();
  }
  recovered(): void {
    this.unresolved = false;
    this.offeredRecord = null;
    this.publish({ offer: null });
    this.markDirty();
    this.schedule();
  }
  requireOwner(): void {
    if (!this.state.owner)
      throw new Error(
        'Another tab owns recovery. Retry recovery ownership before recovering or discarding a snapshot.',
      );
  }
  showOffer(visible: boolean): void {
    this.publish({ offerVisible: visible });
  }
  archiveForRecovery(): Blob {
    this.requireOwner();
    if (!this.offeredRecord)
      throw new Error('No valid recovery snapshot is available.');
    return this.offeredRecord.archive;
  }
}
