import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { TrackId } from '@loopbeats/domain';
import { AudioClient } from '@loopbeats/audio-client';
import { TrackStrip } from './TrackStrip';
import { SessionExport } from './SessionExport';
import { SessionImport } from './SessionImport';
import { SettingsPanel, type SettingsGroup } from './SettingsPanel';

type Removal = { kind: 'track'; trackId: TrackId } | { kind: 'session' };
type InputDevice = { id: string; label: string };
const SETTINGS_KEY = 'loopbeats.settings.v1';
type StoredSettings = {
  confirmClearing: boolean;
  preferredInputId: string | null;
  masterGain: number;
  tracks: readonly { mode: 'Loop' | 'OneShot'; gain: number; muted: boolean }[];
};

const defaultSettings = (): StoredSettings => ({
  confirmClearing: true,
  preferredInputId: null,
  masterGain: 1,
  tracks: [
    { mode: 'Loop', gain: 1, muted: false },
    { mode: 'Loop', gain: 1, muted: false },
  ],
});

function readSettings(): StoredSettings | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? 'null',
    );
    if (!value || typeof value !== 'object') return null;
    const settings = value as Partial<StoredSettings>;
    if (
      typeof settings.confirmClearing !== 'boolean' ||
      typeof settings.masterGain !== 'number' ||
      !Number.isFinite(settings.masterGain)
    )
      return null;
    if (!Array.isArray(settings.tracks) || settings.tracks.length !== 2)
      return null;
    const tracks = settings.tracks.map((track) => {
      if (!track || (track.mode !== 'Loop' && track.mode !== 'OneShot'))
        throw new Error('invalid settings');
      if (!Number.isFinite(track.gain) || typeof track.muted !== 'boolean')
        throw new Error('invalid settings');
      return {
        mode: track.mode,
        gain: Math.max(0, Math.min(1, track.gain)),
        muted: track.muted,
      };
    });
    return {
      confirmClearing: settings.confirmClearing,
      preferredInputId:
        typeof settings.preferredInputId === 'string'
          ? settings.preferredInputId
          : null,
      masterGain: Math.max(0, Math.min(1, settings.masterGain)),
      tracks,
    };
  } catch {
    return null;
  }
}

function writeSettings(settings: StoredSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup>('Session');
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const selectedSettingsTab = useRef<HTMLButtonElement>(null);
  const focusSettingsGroup = useCallback(
    () => selectedSettingsTab.current?.focus(),
    [],
  );
  const performanceShell = useRef<HTMLDivElement>(null);
  const settingsOpener = useRef<HTMLElement | null>(null);
  const [transferStatus, setTransferStatus] = useState('');
  const [preferenceSave, setPreferenceSave] = useState<
    'saved' | 'failed' | null
  >(null);
  const openSettings = (group?: SettingsGroup) => {
    settingsOpener.current = document.activeElement as HTMLElement | null;
    if (group) setSettingsGroup(group);
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    if (document.querySelector('dialog[open]')) return;
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      const opener = settingsOpener.current;
      if (opener?.isConnected) opener.focus();
      if (document.activeElement !== opener) settingsTrigger.current?.focus();
    });
  };
  const [sessionBusy, setSessionBusy] = useState(false);
  const [storedSettings] = useState(readSettings);
  const lastMix = useRef<Pick<StoredSettings, 'masterGain' | 'tracks'>>(
    storedSettings ?? defaultSettings(),
  );
  const [confirmClearing, setConfirmClearing] = useState(
    () => storedSettings?.confirmClearing ?? true,
  );
  const [inputDevices, setInputDevices] = useState<readonly InputDevice[]>([]);
  const [preferredInputId, setPreferredInputId] = useState(
    () => storedSettings?.preferredInputId ?? '',
  );
  const [switchPending, setSwitchPending] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<Removal | null>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const removalTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!pendingRemoval) return;
    const dialog = confirmation.current;
    const settingsTab = selectedSettingsTab.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      dialog?.close();
      const trigger = removalTrigger.current;
      if (!trigger?.isConnected) return;
      trigger.focus();
      if (document.activeElement !== trigger)
        (
          trigger.closest('details')?.querySelector('summary') ?? settingsTab
        )?.focus();
    };
  }, [pendingRemoval]);
  const [client] = useState(
    () =>
      new AudioClient({
        wasm: `${import.meta.env.BASE_URL}audio/loop-engine.wasm`,
        worklet: `${import.meta.env.BASE_URL}audio/processor.js`,
      }),
  );
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const recovery = useSyncExternalStore(
    client.subscribe,
    client.getRecoverySnapshot,
  );
  const loadInputDevices = async (): Promise<readonly InputDevice[]> => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Audio input ${index + 1}`,
      }));
  };
  useEffect(() => {
    if (snapshot.status !== 'ready') return;
    const refresh = () => {
      void loadInputDevices().then(setInputDevices);
    };
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () =>
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [client, snapshot.status]);
  const restored = useRef(false);
  const skipPersistence = useRef(false);
  useEffect(() => {
    if (snapshot.status !== 'ready') {
      restored.current = false;
      return;
    }
    if (restored.current) return;
    const settings = readSettings() ?? storedSettings;
    if (!settings) return;
    restored.current = true;
    skipPersistence.current = true;
    client.setMasterGain(settings.masterGain);
    settings.tracks.forEach((track, index) => {
      const trackId = index as TrackId;
      client.setTrackGain(trackId, track.gain);
      client.setTrackMute(trackId, track.muted);
      if (track.mode === 'OneShot') client.setMode(trackId, track.mode);
    });
  }, [client, snapshot.status, storedSettings]);
  const persistPreferences = useCallback(
    (confirmation = confirmClearing, inputId = preferredInputId) => {
      const current = ['ready', 'interrupted', 'recovering'].includes(
        snapshot.status,
      )
        ? {
            masterGain: snapshot.masterGain,
            tracks: snapshot.tracks.map(({ mode, gain, muted }) => ({
              mode,
              gain,
              muted,
            })),
          }
        : lastMix.current;
      lastMix.current = current;
      setPreferenceSave(
        writeSettings({
          ...current,
          confirmClearing: confirmation,
          preferredInputId: inputId || null,
        })
          ? 'saved'
          : 'failed',
      );
    },
    [snapshot, confirmClearing, preferredInputId],
  );
  useEffect(() => {
    if (snapshot.status !== 'ready') return;
    if (skipPersistence.current) {
      skipPersistence.current = false;
      return;
    }
    persistPreferences();
  }, [persistPreferences, snapshot.status]);
  useEffect(() => {
    const warnIfRecording = (event: BeforeUnloadEvent) => {
      if (snapshot.tracks.some((track) => track.state !== 'Empty')) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warnIfRecording);
    return () => window.removeEventListener('beforeunload', warnIfRecording);
  }, [snapshot.tracks]);
  useEffect(() => {
    const disableRecovery = client.enableRecovery();
    const release = () => {
      disableRecovery();
      void client.stop();
    };
    const resume = () => {
      client.enableRecovery();
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', resume);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', resume);
      release();
    };
  }, [client]);
  const remove = (target: Removal) => {
    if (target.kind === 'track') void client.clear(target.trackId);
    else void client.reset();
    // The confirmed action may disable its trigger when the engine replies.
    // Return to the disclosure so focus survives that asynchronous update.
    removalTrigger.current =
      removalTrigger.current?.closest('details')?.querySelector('summary') ??
      (target.kind === 'session' ? selectedSettingsTab.current : null) ??
      removalTrigger.current;
    setPendingRemoval(null);
  };
  const requestRemoval = (target: Removal) => {
    if (target.kind === 'session' || confirmClearing) {
      removalTrigger.current = document.activeElement as HTMLElement | null;
      setPendingRemoval(target);
    } else remove(target);
  };
  const ready = snapshot.status === 'ready';
  const tracksActive = snapshot.tracks.some((track) =>
    ['Recording', 'Playing', 'Overdubbing'].includes(track.state),
  );
  const tracksPlayable = snapshot.tracks.some(
    (track) => track.state === 'Stopped' && track.canPlay,
  );
  const starting =
    snapshot.status === 'starting' || snapshot.status === 'recovering';
  const status = {
    idle: 'Audio stopped',
    starting: 'Starting audio — allow microphone access when prompted',
    ready: 'Audio ready',
    interrupted: 'Audio interrupted — recordings retained',
    recovering: 'Reinitializing audio — recordings retained',
    stopping: 'Stopping audio',
    error: 'Audio could not start',
  }[snapshot.status];
  return (
    <main className={`shell${settingsOpen ? ' settings-open' : ''}`}>
      <div id="performance-shell" ref={performanceShell}>
        <header className="brand-header">
          <div>
            <p className="eyebrow">Two-track performance station</p>
            <h1>LoopBeats</h1>
          </div>
          <p className="intro">Build a performance, one layer at a time.</p>
        </header>
        {recovery.offer && recovery.offerVisible && (
          <aside aria-label="Recovery available">
            <p>
              A recovery snapshot is available from{' '}
              {new Date(recovery.offer.savedAt).toLocaleString()}. Your live
              session has not been replaced.
            </p>
            <button onClick={() => openSettings('Session')}>
              View recovery
            </button>
          </aside>
        )}
        <section className="instrument" aria-labelledby="status-heading">
          <div className="master-strip">
            <div className="session-status">
              <h2 id="status-heading">Audio session</h2>
              <p role="status" aria-label="Audio status">
                {status}
              </p>
              <p className="session-guidance" aria-live="polite">
                Recovery: {recovery.status} {recovery.error}
              </p>
              {snapshot.error && <p role="alert">{snapshot.error}</p>}
              <p className="session-guidance">
                Use wired headphones. Monitoring starts off.
              </p>
              <p className="session-guidance">
                Recordings are temporary. Preferences do not save recordings.
                Browsers cannot guarantee prevention of page closure or recovery
                of temporary audio.
              </p>
              <div className="controls">
                <button
                  disabled={
                    ready ||
                    starting ||
                    snapshot.status === 'stopping' ||
                    snapshot.status === 'interrupted'
                  }
                  onClick={() => {
                    void client.start(preferredInputId || undefined);
                  }}
                >
                  Start audio
                </button>
                <button
                  disabled={
                    !ready && !starting && snapshot.status !== 'interrupted'
                  }
                  onClick={() => {
                    void client.discardSession();
                  }}
                >
                  {snapshot.status === 'recovering'
                    ? 'Cancel recovery and discard session'
                    : starting
                      ? 'Cancel audio startup'
                      : 'Stop audio — discard session'}
                </button>
                {(snapshot.status === 'interrupted' ||
                  snapshot.status === 'recovering') && (
                  <button
                    disabled={snapshot.status !== 'interrupted'}
                    onClick={() => {
                      void client.reinitialize();
                    }}
                  >
                    Reinitialize audio
                  </button>
                )}
                <button
                  disabled={!ready || switchPending}
                  aria-pressed={snapshot.monitoring}
                  onClick={() => client.setMonitoring(!snapshot.monitoring)}
                >
                  {snapshot.monitoring
                    ? 'Disable monitoring'
                    : 'Enable monitoring'}
                </button>
              </div>
              <p>{snapshot.monitoring ? 'Monitoring on' : 'Monitoring off'}</p>
            </div>
            <div className="level-meters">
              <label>
                Input{' '}
                <meter
                  min="0"
                  max="1"
                  value={snapshot.inputLevel}
                  aria-label="Input level"
                />
              </label>
              <span data-testid="input-level">
                {snapshot.inputLevel.toFixed(3)}
              </span>
              <label>
                Output{' '}
                <meter
                  min="0"
                  max="1"
                  value={snapshot.outputLevel}
                  aria-label="Output level"
                />
              </label>
              <span data-testid="output-level">
                {snapshot.outputLevel.toFixed(3)}
              </span>
            </div>
            <label className="master-gain">
              Master volume
              <input
                type="range"
                aria-label="Master volume"
                min="0"
                max="1"
                step="0.01"
                value={snapshot.masterGain}
                disabled={!ready || switchPending}
                onChange={(event) =>
                  client.setMasterGain(Number(event.currentTarget.value))
                }
              />
              <span>{Math.round(snapshot.masterGain * 100)}%</span>
            </label>
            <section aria-labelledby="transport-heading">
              <h2 id="transport-heading">Transport</h2>
              <p data-testid="transport-state">
                {snapshot.transport.running ? 'Running' : 'Stopped'}
              </p>
              <button
                disabled={
                  switchPending || !ready || (!tracksActive && !tracksPlayable)
                }
                onClick={() => {
                  if (!ready || switchPending) return;
                  if (tracksActive) client.stopTransport();
                  else if (tracksPlayable) client.startTracks();
                }}
              >
                {tracksActive ? 'Global STOP' : 'Global Start'}
              </button>
            </section>
          </div>
          <div className="track-bank">
            {snapshot.tracks.map((track, index) => (
              <TrackStrip
                key={index}
                track={track}
                trackId={index as TrackId}
                sampleRate={snapshot.sampleRate}
                cycleLengthSamples={snapshot.transport.cycleLengthSamples}
                enabled={ready && !switchPending}
                client={client}
                onClear={() =>
                  requestRemoval({ kind: 'track', trackId: index as TrackId })
                }
              />
            ))}
          </div>
          <div className="settings-launcher">
            <button
              ref={settingsTrigger}
              aria-expanded={settingsOpen}
              aria-controls="settings-panel"
              onClick={() => (settingsOpen ? closeSettings() : openSettings())}
            >
              Settings
            </button>
            {transferStatus && !settingsOpen && (
              <>
                <p role="status">{transferStatus}</p>
                <button onClick={() => openSettings('Session')}>
                  View progress
                </button>
              </>
            )}
          </div>
          <details className="session-tools">
            <summary>Diagnostics</summary>
            {ready ? (
              <dl className="diagnostics">
                <dt>Sample rate</dt>
                <dd>{snapshot.sampleRate} Hz</dd>
                <dt>Processed frames</dt>
                <dd>{snapshot.processedFrames}</dd>
                <dt>Input level</dt>
                <dd>{snapshot.inputLevel.toFixed(3)}</dd>
                <dt>Output level</dt>
                <dd>{snapshot.outputLevel.toFixed(3)}</dd>
              </dl>
            ) : (
              <p>Start audio to see live diagnostics.</p>
            )}
            <p>
              Timeline samples:{' '}
              <span data-testid="transport-position">
                {snapshot.transport.positionSamples}
              </span>
            </p>
            <p>
              Shared cycle samples:{' '}
              <span data-testid="cycle-length">
                {snapshot.transport.cycleLengthSamples}
              </span>
            </p>
            <p>
              Global STOP resets the timeline and retains completed audio;
              unfinished first capture is discarded. Monitoring is independent.
            </p>
          </details>
        </section>
      </div>
      <SettingsPanel
        selectedTabRef={selectedSettingsTab}
        backgroundRef={performanceShell}
        open={settingsOpen}
        group={settingsGroup}
        onGroup={setSettingsGroup}
        onClose={closeSettings}
      >
        {{
          Session: (
            <>
              {' '}
              <SessionExport
                client={client}
                onBusy={setSessionBusy}
                onStatus={setTransferStatus}
                enabled={
                  ready &&
                  !sessionBusy &&
                  !switchPending &&
                  !snapshot.tracks.some(
                    (track) => track.state === 'Overdubbing',
                  )
                }
              />
              <SessionImport
                client={client}
                onBusy={setSessionBusy}
                onStatus={setTransferStatus}
                onConfirmation={() => {
                  setSettingsGroup('Session');
                  setSettingsOpen(true);
                }}
                onRestoreFocus={focusSettingsGroup}
                enabled={
                  ready &&
                  !sessionBusy &&
                  !switchPending &&
                  !snapshot.tracks.some((t) =>
                    ['Recording', 'Overdubbing'].includes(t.state),
                  )
                }
              />
              <section
                className="destructive-controls"
                aria-labelledby="reset-heading"
              >
                <h2 id="reset-heading">Remove session recordings</h2>
                <p>
                  Reset removes every recording and the shared cycle. Track
                  CLEAR removes only that recording.
                </p>
                <button
                  disabled={
                    switchPending ||
                    !ready ||
                    (!snapshot.transport.cycleLengthSamples &&
                      snapshot.tracks.every((track) => track.state === 'Empty'))
                  }
                  onClick={() => requestRemoval({ kind: 'session' })}
                >
                  Reset session
                </button>
              </section>
            </>
          ),
          Audio: (
            <>
              {' '}
              {ready && inputDevices.length > 0 && (
                <label>
                  Audio input
                  <select
                    aria-label="Audio input"
                    value={snapshot.inputDeviceId ?? ''}
                    disabled={
                      switchPending ||
                      snapshot.transport.running ||
                      snapshot.tracks.some((track) =>
                        ['Recording', 'Playing', 'Overdubbing'].includes(
                          track.state,
                        ),
                      )
                    }
                    onChange={(event) => {
                      const deviceId = event.currentTarget.value;
                      setSwitchPending(true);
                      void client.switchInput(deviceId).then((switched) => {
                        if (switched) {
                          setPreferredInputId(deviceId);
                          persistPreferences(confirmClearing, deviceId);
                          void loadInputDevices().then(setInputDevices);
                        }
                        setSwitchPending(false);
                      });
                    }}
                  >
                    <option value="">System default</option>
                    {inputDevices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {ready && (
                <p>
                  Stop playback and capture before changing inputs. Completed
                  recordings are retained and the shared transport is reset.
                </p>
              )}
              {!ready && (
                <p>
                  Start audio to select an input. Saved preferences are restored
                  when audio starts.
                </p>
              )}
              {switchPending && (
                <p role="status">
                  Changing audio input. Track controls are unavailable until
                  switching finishes.
                </p>
              )}
              {ready && (
                <p>
                  Current input:{' '}
                  {inputDevices.find(
                    (device) => device.id === snapshot.inputDeviceId,
                  )?.label ?? 'System-selected input'}
                </p>
              )}
              {ready &&
                preferredInputId &&
                snapshot.inputDeviceId !== preferredInputId && (
                  <p role="status">
                    Preferred input is unavailable; using the system-selected
                    input.
                  </p>
                )}
            </>
          ),
          Preferences: (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmClearing}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    setConfirmClearing(enabled);
                    persistPreferences(enabled);
                  }}
                />{' '}
                Confirm before clearing
              </label>
              <p>
                Changes apply immediately. Preferences do not save recordings.
              </p>
              {preferenceSave && (
                <p role="status">
                  {preferenceSave === 'saved'
                    ? 'Saved in this browser.'
                    : 'Applied for this visit; could not save in this browser.'}
                </p>
              )}
              {preferenceSave === 'failed' && (
                <button onClick={() => persistPreferences(confirmClearing)}>
                  Retry saving preferences
                </button>
              )}
            </>
          ),
        }}
      </SettingsPanel>
      {pendingRemoval && (
        <dialog
          ref={confirmation}
          aria-labelledby="removal-heading"
          aria-describedby="removal-description"
          onCancel={() => setPendingRemoval(null)}
        >
          <h2 id="removal-heading">
            {pendingRemoval.kind === 'track'
              ? `Clear Track ${pendingRemoval.trackId + 1}?`
              : 'Reset session?'}
          </h2>
          <p id="removal-description">
            {pendingRemoval.kind === 'track'
              ? 'Remove this recording. The shared cycle and other track remain.'
              : 'Remove all recordings and reset the shared cycle. Monitoring returns off.'}{' '}
            Audio continues until you confirm.
          </p>
          <button onClick={() => setPendingRemoval(null)}>Cancel</button>
          <button
            disabled={!ready || switchPending}
            onClick={() => remove(pendingRemoval)}
          >
            Confirm
          </button>
        </dialog>
      )}
    </main>
  );
}
