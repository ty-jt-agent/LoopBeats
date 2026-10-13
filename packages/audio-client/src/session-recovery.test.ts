// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import type { AudioSnapshot } from '@loopbeats/domain';
import type { FxConfig } from '@loopbeats/domain';
import { SessionRecovery, type RecoveryRecord } from './session-recovery';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(initial: RecoveryRecord | null = null) {
  vi.useFakeTimers();
  vi.stubGlobal('indexedDB', {});
  let lockReleased = false;
  let lockRequests = 0;
  vi.stubGlobal('navigator', {
    locks: {
      request: (
        _: string,
        __: unknown,
        callback: (lock: object) => Promise<void>,
      ) => {
        lockRequests++;
        return callback({}).finally(() => {
          lockReleased = true;
        });
      },
    },
  });
  let snapshot: AudioSnapshot = {
    fx: [
      { config: { type: 'None' }, transitioning: false, removing: false },
      { config: { type: 'None' }, transitioning: false, removing: false },
      { config: { type: 'None' }, transitioning: false, removing: false },
      { config: { type: 'None' }, transitioning: false, removing: false },
    ],
    status: 'ready',
    sampleRate: 48000,
    masterGain: 1,
    inputDeviceId: null,
    monitoring: false,
    error: null,
    processedFrames: 0,
    inputLevel: 0,
    outputLevel: 0,
    transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
    tracks: [0, 1].map(() => ({
      mode: 'Loop',
      state: 'Empty',
      gain: 1,
      muted: false,
      lengthSamples: 0,
      positionSamples: 0,
      capturedSamples: 0,
      capacitySamples: 2880000,
      captureLimitSamples: 2880000,
      canRecord: true,
      canPlay: false,
      canStop: false,
      canSetMode: true,
      canSetLoop: true,
    })) as unknown as AudioSnapshot['tracks'],
  };
  const withFx = (scope: number, config: FxConfig, transitioning = false) => {
    const fx = snapshot.fx!.map((slot) => ({ ...slot })) as {
      config: FxConfig;
      transitioning: boolean;
      removing: boolean;
    }[];
    fx[scope] = { ...fx[scope]!, config, transitioning };
    snapshot = { ...snapshot, fx: fx as unknown as AudioSnapshot['fx'] };
    recovery.observe(snapshot, [0, 0]);
  };
  let record: RecoveryRecord | null = initial;
  let failWrite = false;
  let writes = 0;
  let waitDeletion: Promise<void> | undefined;
  let releaseDeletion: (() => void) | undefined;
  let waitRead: Promise<void> | undefined;
  let releaseRead: (() => void) | undefined;
  let waitCheckpoint: Promise<void> | undefined;
  let releaseCheckpoint: (() => void) | undefined;
  const storage = {
    read: async () => {
      await waitRead;
      return record;
    },
    write: async (value: RecoveryRecord) => {
      writes++;
      if (failWrite) throw new Error('Quota exceeded');
      record = value;
    },
    delete: async () => {
      await waitDeletion;
      record = null;
    },
  };
  const recovery = new SessionRecovery(
    {
      snapshot: () => snapshot,
      available: () => true,
      checkpoint: async () => {
        const startedAt = Date.now();
        await waitCheckpoint;
        return {
          archive: new Blob(['checkpoint samples']),
          progress: { startedAt, captureKinds: [null, null] },
        };
      },
      notify: () => {},
    },
    storage,
  );
  return {
    recovery,
    snapshot,
    read: () => record,
    writes: () => writes,
    fail: () => {
      failWrite = true;
    },
    holdDeletion: () => {
      waitDeletion = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
    },
    releaseDeletion: () => releaseDeletion?.(),
    lockReleased: () => lockReleased,
    lockRequests: () => lockRequests,
    holdRead: () => {
      waitRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead: () => releaseRead?.(),
    holdCheckpoint: () => {
      waitCheckpoint = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
    },
    releaseCheckpoint: () => releaseCheckpoint?.(),
    update: (value: AudioSnapshot) => {
      snapshot = value;
      recovery.observe(value, [0, 0]);
    },
    withFx,
  };
}

test('acknowledged FX target changes dirty recovery independently of audio and ramp progress', async () => {
  const { recovery, withFx, writes, read } = fixture();
  await recovery.initialize();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read()?.revision).toBe(1);

  const target = { type: 'LowPass', cutoffHz: 2400, bypassed: false } as const;
  withFx(3, target);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read()?.revision).toBe(2);
  expect(writes()).toBe(2);

  withFx(3, target, true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(read()?.revision).toBe(2);
  expect(writes()).toBe(2);
  recovery.dispose();
});

test('slow transfer preserves five-second deadlines and coalesces an overdue checkpoint', async () => {
  const {
    recovery,
    snapshot,
    update,
    writes,
    holdCheckpoint,
    releaseCheckpoint,
  } = fixture();
  await recovery.initialize();
  update({
    ...snapshot,
    tracks: [{ ...snapshot.tracks[0], state: 'Recording' }, snapshot.tracks[1]],
  });
  holdCheckpoint();
  await vi.advanceTimersByTimeAsync(7000);
  expect(writes()).toBe(0);
  releaseCheckpoint();
  await vi.advanceTimersByTimeAsync(0);
  expect(writes()).toBe(1);
  await vi.advanceTimersByTimeAsync(2999);
  expect(writes()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes()).toBe(2);
  holdCheckpoint();
  await vi.advanceTimersByTimeAsync(11000);
  expect(writes()).toBe(2);
  releaseCheckpoint();
  await vi.advanceTimersByTimeAsync(1);
  expect(writes()).toBe(4);
  recovery.dispose();
});

test('eligible changes debounce and save despite continuous changes at five seconds', async () => {
  const { recovery, snapshot, read } = fixture();
  await recovery.initialize();
  for (let i = 1; i <= 6; i++) {
    await vi.advanceTimersByTimeAsync(800);
    recovery.observe({ ...snapshot, masterGain: i / 10 }, [0, 0]);
    expect(read()).toBeNull();
  }
  await vi.advanceTimersByTimeAsync(200);
  expect(read()?.revision).toBe(1);
  expect(recovery.getSnapshot().status).toContain('Saved at');
  recovery.dispose();
});

test('audio readiness cannot overwrite a recovery snapshot during a delayed startup read', async () => {
  const record: RecoveryRecord = {
    version: 1,
    revision: 1,
    savedAt: 100,
    archive: new Blob(['old completed samples']),
  };
  const { recovery, snapshot, holdRead, releaseRead, writes, read } =
    fixture(record);
  holdRead();
  const initializing = recovery.initialize();
  await vi.advanceTimersByTimeAsync(0);
  recovery.observe(snapshot, [0, 0]);
  await vi.advanceTimersByTimeAsync(6000);
  expect(writes()).toBe(0);
  releaseRead();
  await initializing;
  await vi.advanceTimersByTimeAsync(10000);
  expect(read()).toBe(record);
  expect(recovery.getSnapshot().offer?.savedAt).toBe(100);
  expect(writes()).toBe(0);
  recovery.dispose();
});

test('initialization waiting for release cannot acquire a lock after a newer disposal', async () => {
  const { recovery, holdDeletion, releaseDeletion, lockRequests } = fixture();
  await recovery.initialize();
  holdDeletion();
  const deleting = recovery.beforeDestructive();
  await vi.advanceTimersByTimeAsync(0);
  recovery.dispose();
  const initializing = recovery.initialize();
  recovery.dispose();
  releaseDeletion();
  await deleting;
  await initializing;
  expect(lockRequests()).toBe(1);
  recovery.dispose();
});

test('overdub checkpoints every five seconds and completion saves promptly; playback alone is ignored', async () => {
  const { recovery, snapshot, update, writes } = fixture();
  await recovery.initialize();
  await vi.advanceTimersByTimeAsync(1000);
  update({
    ...snapshot,
    processedFrames: 1000,
    transport: { ...snapshot.transport, positionSamples: 1000 },
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(writes()).toBe(1);
  const overdub = {
    ...snapshot,
    masterGain: 0.5,
    tracks: [
      { ...snapshot.tracks[0], state: 'Overdubbing' as const },
      snapshot.tracks[1],
    ] as AudioSnapshot['tracks'],
  };
  update(overdub);
  await vi.advanceTimersByTimeAsync(4999);
  expect(writes()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes()).toBe(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(writes()).toBe(3);
  update({
    ...overdub,
    tracks: [{ ...overdub.tracks[0], state: 'Stopped' }, overdub.tracks[1]],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(writes()).toBe(4);
  recovery.dispose();
});

test('a pending previous-workspace snapshot survives live deletions until explicit discard', async () => {
  const record: RecoveryRecord = {
    version: 1,
    revision: 1,
    savedAt: 100,
    archive: new Blob(['old completed samples']),
  };
  const { recovery, read, writes } = fixture(record);
  await recovery.initialize();
  recovery.showOffer(false);
  await recovery.beforeDestructive();
  await vi.advanceTimersByTimeAsync(10000);
  expect(read()).toBe(record);
  expect(writes()).toBe(0);
  await recovery.discard();
  expect(read()).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read()?.revision).toBe(2);
  recovery.dispose();
});

test('disposal keeps ownership until a pending deletion barrier has finished', async () => {
  const { recovery, holdDeletion, releaseDeletion, lockReleased } = fixture();
  await recovery.initialize();
  holdDeletion();
  const deleting = recovery.beforeDestructive();
  await vi.advanceTimersByTimeAsync(0);
  recovery.dispose();
  await vi.advanceTimersByTimeAsync(0);
  expect(lockReleased()).toBe(false);
  releaseDeletion();
  await deleting;
  await vi.advanceTimersByTimeAsync(0);
  expect(lockReleased()).toBe(true);
});

test('write failure retains the last checkpoint and rate-limits retries across new changes', async () => {
  const { recovery, snapshot, read, fail, writes } = fixture();
  await recovery.initialize();
  await vi.advanceTimersByTimeAsync(1000);
  const saved = read();
  fail();
  recovery.observe({ ...snapshot, masterGain: 0.5 }, [0, 0]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(recovery.getSnapshot().error).toContain('Quota');
  expect(read()).toBe(saved);
  recovery.observe({ ...snapshot, masterGain: 0.25 }, [0, 0]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(recovery.getSnapshot().status).not.toContain('Saving');
  expect(writes()).toBe(2);
  expect(read()).toBe(saved);
  recovery.dispose();
});
