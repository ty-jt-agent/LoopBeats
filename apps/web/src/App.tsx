import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  AudioApplication,
  AudioApplicationCommand,
  AudioSnapshot,
  FxConfig,
  FxScope,
  TrackId,
} from '@loopbeats/domain';
import type { WebAudioExtensions } from './web-audio-extensions';
import { recoveryDeletionNotice } from './recovery-deletion-notice';
import { TrackStrip } from './TrackStrip';
import { SessionExport } from './SessionExport';
import { SessionImport } from './SessionImport';
import { recoveryPresentation } from './recovery-presentation';
import { SettingsPanel, type SettingsGroup } from './SettingsPanel';
import { FxEditor, FxScopeLauncher } from './FxEditor';
import { fxStateLabel } from './fx-state';

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

const noRecovery = {
  status: 'Recovery is unavailable in this host.',
  owner: false,
  offer: null,
  savedAt: null,
  error: null,
  offerVisible: false,
} as const;
const getNoRecoverySnapshot = () => noRecovery;

export function App({
  audio,
  web,
}: {
  audio: AudioApplication;
  web?: WebAudioExtensions;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup>('Session');
  const [fxEditorOpen, setFxEditorOpen] = useState(false);
  const [fxEditorScope, setFxEditorScope] = useState<FxScope>(0);
  const [fxEditorFocusRequest, setFxEditorFocusRequest] = useState(0);
  const fxEditorOpener = useRef<HTMLButtonElement | null>(null);
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
  };
  const previouslyOpen = useRef(false);
  useLayoutEffect(() => {
    if (previouslyOpen.current && !settingsOpen) {
      const opener = settingsOpener.current;
      if (opener?.isConnected) opener.focus();
      if (document.activeElement !== opener) settingsTrigger.current?.focus();
    }
    previouslyOpen.current = settingsOpen;
  }, [settingsOpen]);
  const previouslyFxEditorOpen = useRef(false);
  useLayoutEffect(() => {
    if (previouslyFxEditorOpen.current && !fxEditorOpen) {
      const opener = fxEditorOpener.current;
      if (opener?.isConnected) opener.focus();
    }
    previouslyFxEditorOpen.current = fxEditorOpen;
  }, [fxEditorOpen]);
  const openFxEditor = (scope: FxScope, trigger: HTMLButtonElement) => {
    const sameOpener = fxEditorOpener.current === trigger;
    if (fxEditorOpen || !sameOpener) setFxEditorScope(scope);
    fxEditorOpener.current = trigger;
    setFxEditorFocusRequest((request) => request + 1);
    setFxEditorOpen(true);
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
  const [inputListError, setInputListError] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<Removal | null>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const removalTrigger = useRef<HTMLElement | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const [failedRemoval, setFailedRemoval] = useState<Removal | null>(null);
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
  const applicationSnapshot = useSyncExternalStore(
    audio.subscribe,
    audio.getApplicationSnapshot,
  );
  const snapshot: AudioSnapshot = useMemo(
    () => ({ ...applicationSnapshot.engine, ...applicationSnapshot.host }),
    [applicationSnapshot.engine, applicationSnapshot.host],
  );
  const recoverySubscribe = web?.subscribe ?? audio.subscribe;
  const getRecoverySnapshot = web?.getRecoverySnapshot ?? getNoRecoverySnapshot;
  const recovery = useSyncExternalStore(recoverySubscribe, getRecoverySnapshot);
  const capabilities = audio.getCapabilities();
  const onFxConfigChange = useCallback(
    (scope: FxScope, config: FxConfig) => {
      if (web) {
        if (scope === 0) web.setInputFx(config);
        else web.setPlaybackFx(scope, config);
        return;
      }
      const nativeAudio = audio as AudioApplication & {
        setFx?: (scope: FxScope, config: FxConfig) => void;
      };
      nativeAudio.setFx?.(scope, config);
    },
    [audio, web],
  );
  const [commandError, setCommandError] = useState('');
  const sendCommand = useCallback(
    (command: AudioApplicationCommand) => {
      const submission = audio.submit(command);
      if (submission.status === 'rejected') {
        setCommandError(
          submission.reason === 'overloaded'
            ? 'Audio command capacity is full. Wait briefly and try again.'
            : submission.reason === 'invalid-command'
              ? 'That audio setting is invalid.'
              : 'Audio is unavailable for that command.',
        );
        return submission;
      }
      setCommandError('');
      void submission.outcome.then((outcome) => {
        if (outcome.status !== 'applied')
          setCommandError(
            outcome.status === 'failed'
              ? (outcome.error ??
                  'The audio engine could not apply the command.')
              : 'The audio session changed before the command was applied.',
          );
      });
      return submission;
    },
    [audio],
  );
  const refreshInputDevices = useCallback(async () => {
    if (!web?.listInputDevices) return;
    try {
      setInputDevices(await web.listInputDevices());
      setInputListError('');
    } catch {
      setInputListError(
        'Could not list input devices. Retry listing inputs when audio is ready.',
      );
    }
  }, [web]);
  useEffect(() => {
    if (!web || snapshot.status !== 'ready') return;
    const refresh = () => {
      void refreshInputDevices();
    };
    refresh();
    return web.subscribeInputDeviceChanges?.(refresh);
  }, [web, snapshot.status, refreshInputDevices]);
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
    audio.submit({ type: 'set-master-gain', gain: settings.masterGain });
    settings.tracks.forEach((track, index) => {
      const trackId = index as TrackId;
      audio.submit({ type: 'set-track-gain', trackId, gain: track.gain });
      audio.submit({ type: 'set-track-mute', trackId, muted: track.muted });
      if (track.mode === 'OneShot')
        audio.submit({ type: 'set-mode', trackId, mode: track.mode });
    });
  }, [audio, sendCommand, snapshot.status, storedSettings]);
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
    if (!web) return;
    const disableRecovery = web.enableRecovery();
    const release = () => {
      disableRecovery();
      void audio.stop();
    };
    const resume = () => {
      web.enableRecovery();
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', resume);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', resume);
      release();
    };
  }, [audio, web]);
  const recoveryRemovalWarning = recoveryDeletionNotice(recovery);
  const remove = async (target: Removal) => {
    setRemoving(true);
    setRemovalError('');
    setFailedRemoval(target);
    let sent = false;
    try {
      const submission = sendCommand(
        target.kind === 'track'
          ? { type: 'clear', trackId: target.trackId }
          : { type: 'reset' },
      );
      if (submission.status === 'rejected')
        throw new Error(
          submission.reason === 'overloaded'
            ? 'Audio command capacity is full.'
            : 'Audio is unavailable.',
        );
      const outcome = await submission.outcome;
      sent = outcome.status === 'applied';
      if (!sent)
        setRemovalError(
          `${outcome.status === 'failed' ? (outcome.error ?? 'The engine could not apply the command.') : 'Audio session changed before removal.'} Recordings remain unchanged. Retry ${target.kind === 'session' ? 'Reset session and confirm again' : `CLEAR on Track ${target.trackId + 1}`}.`,
        );
    } catch (failure) {
      setRemovalError(
        failure instanceof Error
          ? `${failure.message} Recordings remain unchanged. Try again.`
          : 'Could not remove recordings. Recordings remain unchanged. Try again.',
      );
    } finally {
      setRemoving(false);
    }
    // The confirmed action may disable its trigger when the engine replies.
    // Return to the disclosure so focus survives that asynchronous update.
    if (sent)
      removalTrigger.current =
        removalTrigger.current?.closest('details')?.querySelector('summary') ??
        (target.kind === 'session' ? selectedSettingsTab.current : null) ??
        removalTrigger.current;
    setPendingRemoval(null);
  };
  const requestRemoval = (target: Removal) => {
    setRemovalError('');
    if (target.kind === 'session' || confirmClearing) {
      removalTrigger.current = document.activeElement as HTMLElement | null;
      setPendingRemoval(target);
    } else void remove(target);
  };
  const ready = snapshot.status === 'ready';
  const overdubbing = snapshot.tracks.some(
    (track) => track.state === 'Overdubbing',
  );
  const recording = snapshot.tracks.some(
    (track) => track.state === 'Recording',
  );
  const zipReason = !ready
    ? 'Start audio to use session files.'
    : sessionBusy
      ? 'Wait for the current session operation or cancel it when available.'
      : switchPending
        ? 'Wait for the input change to finish.'
        : overdubbing
          ? 'Finish or stop overdubbing before using session files.'
          : '';

  const tracksActive = snapshot.tracks.some((track) =>
    ['Recording', 'Playing', 'Overdubbing'].includes(track.state),
  );
  const tracksPlayable = snapshot.tracks.some(
    (track) => track.state === 'Stopped' && track.canPlay,
  );
  const defaultFxCutoff = Math.min(
    20000,
    (snapshot.sampleRate ?? 48000) * 0.45,
  );
  const hasNonDefaultFx =
    snapshot.fx?.some(({ config }) => {
      if (config.type !== 'LowPass' || !config.bypassed) return true;
      return Math.abs(config.cutoffHz - defaultFxCutoff) > 0.001;
    }) ?? false;
  const starting =
    snapshot.status === 'starting' || snapshot.status === 'recovering';
  const status = {
    idle: 'Audio stopped',
    starting: web
      ? 'Starting audio — allow microphone access when prompted'
      : 'Starting Windows audio host',
    ready: 'Audio ready',
    interrupted: 'Audio interrupted — recordings retained',
    recovering: 'Reinitializing audio — recordings retained',
    stopping: 'Stopping audio',
    error: 'Audio could not start',
  }[snapshot.status];
  const captureInterruption = applicationSnapshot.host.captureInterruption;
  const interruptedTrackNames = (trackIds: readonly number[]) =>
    trackIds.map((trackId) => `Track ${trackId + 1}`).join(' and ');
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
                Recovery: {recoveryPresentation(recovery).summary}{' '}
                {recovery.error}
              </p>
              {snapshot.error && <p role="alert">{snapshot.error}</p>}
              {snapshot.status === 'interrupted' && captureInterruption && (
                <p role="alert" aria-live="assertive">
                  Capture interrupted. Transport reset and monitoring turned
                  off.{' '}
                  {captureInterruption.initialRecordingDiscardedTracks.length >
                    0 &&
                    `${interruptedTrackNames(captureInterruption.initialRecordingDiscardedTracks)}'s unfinished recording was discarded. `}
                  Completed recordings were retained.
                  {captureInterruption.overdubMayBePartialTracks.length > 0 &&
                    ` ${interruptedTrackNames(captureInterruption.overdubMayBePartialTracks)} overdub may be partial; additions already written were retained.`}
                </p>
              )}
              {commandError && <p role="alert">{commandError}</p>}
              <p className="session-guidance">
                Use wired headphones. Monitoring starts off. Input FX:{' '}
                {fxStateLabel(snapshot.fx?.[0])}
              </p>
              <p className="session-guidance">
                Recordings are temporary. Preferences do not save recordings.
                {web
                  ? 'Browsers cannot guarantee prevention of page closure or recovery of temporary audio.'
                  : 'Closing the application may lose temporary recordings.'}
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
                    void audio.start(
                      web ? preferredInputId || undefined : undefined,
                    );
                  }}
                >
                  Start audio
                </button>
                <button
                  disabled={
                    !ready && !starting && snapshot.status !== 'interrupted'
                  }
                  onClick={() => {
                    if (web) void web.discardSession();
                    else void audio.stop();
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
                      void audio.reinitialize();
                    }}
                  >
                    Reinitialize audio
                  </button>
                )}
                <button
                  disabled={!ready || switchPending}
                  aria-pressed={snapshot.monitoring}
                  onClick={() =>
                    sendCommand({
                      type: 'monitoring',
                      enabled: !snapshot.monitoring,
                    })
                  }
                >
                  {snapshot.monitoring
                    ? 'Disable monitoring'
                    : 'Enable monitoring'}
                </button>
                {capabilities.supportedFxScopes.includes(0) && (
                  <FxScopeLauncher
                    scope={0}
                    slot={snapshot.fx?.[0]}
                    selected={fxEditorOpen && fxEditorScope === 0}
                    onOpen={openFxEditor}
                  />
                )}
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
            <div className="master-volume-controls">
              <div className="master-gain-row">
                <label className="master-gain">
                  Master volume · FX {fxStateLabel(snapshot.fx?.[3])}
                  <input
                    type="range"
                    aria-label="Master volume"
                    min="0"
                    max="1"
                    step="0.01"
                    value={snapshot.masterGain}
                    disabled={!ready || switchPending}
                    onChange={(event) =>
                      sendCommand({
                        type: 'set-master-gain',
                        gain: Number(event.currentTarget.value),
                      })
                    }
                  />
                  <span>{Math.round(snapshot.masterGain * 100)}%</span>
                </label>
                {capabilities.supportedFxScopes.includes(3) && (
                  <FxScopeLauncher
                    scope={3}
                    slot={snapshot.fx?.[3]}
                    selected={fxEditorOpen && fxEditorScope === 3}
                    onOpen={openFxEditor}
                  />
                )}
              </div>
            </div>
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
                  if (tracksActive) sendCommand({ type: 'stop-transport' });
                  else if (tracksPlayable)
                    sendCommand({ type: 'start-tracks' });
                }}
              >
                {tracksActive ? 'Global STOP' : 'Global Start'}
              </button>
            </section>
          </div>
          {fxEditorOpen && (
            <FxEditor
              onConfigChange={onFxConfigChange}
              supportedScopes={capabilities.supportedFxScopes}
              snapshot={snapshot}
              enabled={ready && !switchPending}
              scope={fxEditorScope}
              focusRequest={fxEditorFocusRequest}
              onScopeChange={setFxEditorScope}
              onClose={() => setFxEditorOpen(false)}
            />
          )}
          <div className="track-bank">
            {snapshot.tracks.map((track, index) => (
              <TrackStrip
                key={index}
                track={track}
                trackId={index as TrackId}
                sampleRate={snapshot.sampleRate}
                cycleLengthSamples={snapshot.transport.cycleLengthSamples}
                enabled={ready && !switchPending}
                showFx={capabilities.supportedFxScopes.includes(
                  (index + 1) as FxScope,
                )}
                submit={sendCommand}
                fx={snapshot.fx?.[index + 1]}
                fxEditorScope={fxEditorOpen ? fxEditorScope : null}
                onOpenFx={openFxEditor}
                clearError={
                  failedRemoval?.kind === 'track' &&
                  failedRemoval.trackId === index
                    ? removalError
                    : undefined
                }
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
            <dl>
              <dt>Input device selection</dt>
              <dd>
                {capabilities.inputDeviceSelection
                  ? 'Available'
                  : 'Unavailable'}
              </dd>
              <dt>Output device selection</dt>
              <dd>
                {capabilities.outputDeviceSelection
                  ? 'Available'
                  : 'Unavailable'}
              </dd>
              <dt>Input monitoring</dt>
              <dd>{capabilities.monitoring ? 'Available' : 'Unavailable'}</dd>
              <dt>FX scopes</dt>
              <dd>{capabilities.supportedFxScopes.join(', ') || 'None'}</dd>
            </dl>
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
              {zipReason && <p>{zipReason}</p>}
              {web ? (
                <>
                  <SessionExport
                    client={web}
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
                    disabledReason={
                      !zipReason && recording
                        ? 'Finish or stop recording before loading a session.'
                        : undefined
                    }
                    client={web}
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
                </>
              ) : (
                <p>Session file transfer is unavailable in this host.</p>
              )}
              <section
                className="destructive-controls"
                aria-labelledby="reset-heading"
              >
                <h2 id="reset-heading">Remove recordings</h2>
                <p>
                  Reset removes every recording and the shared cycle. Track
                  CLEAR removes only that recording. Monitoring and FX return
                  off to their default settings; modes, gains, mute and saved
                  preferences remain.
                </p>
                <p>{recoveryRemovalWarning}</p>
                {removalError && failedRemoval?.kind === 'session' && (
                  <p role="alert">{removalError}</p>
                )}
                <button
                  disabled={
                    removing ||
                    switchPending ||
                    !ready ||
                    (!snapshot.transport.cycleLengthSamples &&
                      snapshot.tracks.every(
                        (track) => track.state === 'Empty',
                      ) &&
                      !hasNonDefaultFx)
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
              {!web ? (
                <p>Device selection is managed by this audio host.</p>
              ) : (
                <>
                  {' '}
                  {
                    <label>
                      Input device
                      <select
                        aria-label="Input device"
                        value={snapshot.inputDeviceId ?? ''}
                        disabled={
                          !ready ||
                          inputDevices.length === 0 ||
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
                          void web.switchInput(deviceId).then((switched) => {
                            if (switched) {
                              setPreferredInputId(deviceId);
                              persistPreferences(confirmClearing, deviceId);
                              void refreshInputDevices();
                            }
                            setSwitchPending(false);
                          });
                        }}
                      >
                        <option value="">System default</option>
                        {snapshot.inputDeviceId &&
                          !inputDevices.some(
                            (device) => device.id === snapshot.inputDeviceId,
                          ) && (
                            <option value={snapshot.inputDeviceId}>
                              System-selected input (current)
                            </option>
                          )}
                        {inputDevices.map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  }
                  {ready && (
                    <p>
                      Stop playback and capture before changing inputs.
                      Completed recordings are retained and the shared transport
                      is reset.
                    </p>
                  )}
                  {!ready && (
                    <p>
                      Start audio to choose an input. Saved preferences are
                      restored when audio starts.
                    </p>
                  )}
                  {switchPending && (
                    <p role="status">
                      Changing input. Track controls are unavailable until
                      switching finishes.
                    </p>
                  )}
                  {ready && inputDevices.length === 0 && (
                    <p>
                      No available input devices were listed. Your acknowledged
                      audio input remains in use. Restart audio to check
                      available inputs.
                    </p>
                  )}
                  {inputListError && (
                    <>
                      <p role="alert">{inputListError}</p>
                      <button
                        disabled={!ready}
                        onClick={() => void refreshInputDevices()}
                      >
                        Retry listing inputs
                      </button>
                    </>
                  )}
                  {snapshot.error && (
                    <p>
                      {snapshot.error}{' '}
                      {ready
                        ? 'The acknowledged input is shown; retry selection when playback and capture are stopped.'
                        : snapshot.status === 'interrupted'
                          ? 'Use Reinitialize audio to retry with retained recordings.'
                          : snapshot.status === 'recovering'
                            ? 'Reinitializing audio; wait for the result.'
                            : 'Use Start audio to retry after resolving this failure.'}
                    </p>
                  )}
                  {preferenceSave === 'failed' && (
                    <>
                      <p role="status">
                        Input preference applies for this visit; could not save
                        in this browser.
                      </p>
                      <button onClick={() => persistPreferences()}>
                        Retry saving preferences
                      </button>
                    </>
                  )}
                  {preferenceSave === 'saved' && (
                    <p>Input preference saved in this browser.</p>
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
                        Preferred input is unavailable; using the
                        system-selected input.
                      </p>
                    )}
                </>
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
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!removing) setPendingRemoval(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.stopPropagation();
          }}
        >
          <h2 id="removal-heading">
            {pendingRemoval.kind === 'track'
              ? `Clear Track ${pendingRemoval.trackId + 1}?`
              : 'Reset session?'}
          </h2>
          <p id="removal-description">
            {pendingRemoval.kind === 'track'
              ? 'Remove this recording. The shared cycle and other track remain.'
              : 'Remove all recordings, including unfinished work, and reset the shared cycle and transport to zero. Monitoring returns off and all FX return to their default bypassed settings. Modes, gains, mute and saved preferences remain.'}{' '}
            Audio continues until you confirm.
          </p>
          <p>{recoveryRemovalWarning}</p>
          <button disabled={removing} onClick={() => setPendingRemoval(null)}>
            Cancel
          </button>
          <button
            disabled={!ready || switchPending || removing}
            onClick={() => void remove(pendingRemoval)}
          >
            {removing ? 'Removing recordings...' : 'Confirm'}
          </button>
        </dialog>
      )}
    </main>
  );
}
