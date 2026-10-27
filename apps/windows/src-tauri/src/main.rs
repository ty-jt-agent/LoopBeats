#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod windows_app {
    use loop_engine::{FxConfig, ImportMetadata, ImportTrack, PlaybackMode, TrackState};
    use native_audio_host::{
        AudioCommand, CommandAdapter, CommandOutcome, RetainedSession, SessionTransfer,
    };
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::State;
    use windows_audio_host::{HostConfig, MonitoringHost};

    #[derive(Default)]
    struct HostState {
        lifecycle: Mutex<HostLifecycle>,
        submit_gate: Mutex<()>,
        pending: Mutex<HashMap<u64, u64>>,
        terminal: Mutex<HashMap<u64, serde_json::Value>>,
        session_transfer: Mutex<TransferOperation>,
        transfer_gate: Mutex<()>,
        next_transfer_id: AtomicU64,
    }

    #[derive(Default)]
    struct HostLifecycle {
        host: Option<MonitoringHost>,
        generation: u64,
        recovery_session: Option<RetainedSession>,
    }

    #[derive(Default)]
    enum TransferOperation {
        #[default]
        Idle,
        Export {
            token: u64,
            transfer: SessionTransfer,
            revisions: [u32; 2],
        },
        Import {
            token: u64,
            transfer: SessionTransfer,
        },
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AudioCapabilities {
        input_device_selection: bool,
        output_device_selection: bool,
        monitoring: bool,
        gain_update_coalescing: bool,
        supported_fx_scopes: Vec<u8>,
    }

    #[derive(Deserialize)]
    #[serde(
        tag = "type",
        rename_all = "kebab-case",
        rename_all_fields = "camelCase"
    )]
    enum UiCommand {
        SetTrackGain { track_id: usize, gain: f32 },
        SetTrackMute { track_id: usize, muted: bool },
        SetMasterGain { gain: f32 },
        Monitoring { enabled: bool },
        SetMode { track_id: usize, mode: String },
        Record { track_id: usize },
        Play { track_id: usize },
        StopTrack { track_id: usize },
        StopTransport,
        StartTracks,
        Clear { track_id: usize },
        Reset,
        SetFx { scope: usize, config: FxWire },
    }

    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all_fields = "camelCase")]
    enum FxWire {
        None,
        LowPass { cutoff_hz: f64, bypassed: bool },
    }

    impl From<FxWire> for FxConfig {
        fn from(value: FxWire) -> Self {
            match value {
                FxWire::None => FxConfig::None,
                FxWire::LowPass {
                    cutoff_hz,
                    bypassed,
                } => FxConfig::LowPass {
                    cutoff_hz,
                    bypassed,
                },
            }
        }
    }

    impl TryFrom<UiCommand> for AudioCommand {
        type Error = String;

        fn try_from(command: UiCommand) -> Result<Self, Self::Error> {
            Ok(match command {
                UiCommand::SetTrackGain { track_id, gain } => {
                    AudioCommand::SetTrackGain { track_id, gain }
                }
                UiCommand::SetTrackMute { track_id, muted } => {
                    AudioCommand::SetTrackMute { track_id, muted }
                }
                UiCommand::SetMasterGain { gain } => AudioCommand::SetMasterGain(gain),
                UiCommand::Monitoring { enabled } => AudioCommand::SetMonitoring(enabled),
                UiCommand::SetMode { track_id, mode } => AudioCommand::SetMode {
                    track_id,
                    mode: match mode.as_str() {
                        "Loop" => PlaybackMode::Loop,
                        "OneShot" => PlaybackMode::OneShot,
                        _ => return Err("invalid playback mode".into()),
                    },
                },
                UiCommand::Record { track_id } => AudioCommand::Record(track_id),
                UiCommand::Play { track_id } => AudioCommand::Play(track_id),
                UiCommand::StopTrack { track_id } => AudioCommand::StopTrack(track_id),
                UiCommand::StopTransport => AudioCommand::StopTransport,
                UiCommand::StartTracks => AudioCommand::StartTracks,
                UiCommand::Clear { track_id } => AudioCommand::Clear(track_id),
                UiCommand::Reset => AudioCommand::Reset,
                UiCommand::SetFx { scope, config } => AudioCommand::SetFx {
                    scope,
                    config: config.into(),
                },
            })
        }
    }

    #[tauri::command]
    fn audio_capabilities() -> AudioCapabilities {
        AudioCapabilities {
            input_device_selection: false,
            output_device_selection: false,
            monitoring: true,
            gain_update_coalescing: false,
            supported_fx_scopes: vec![0, 3],
        }
    }

    #[tauri::command]
    fn audio_host_start(
        expected_generation: u64,
        state: State<'_, Arc<HostState>>,
    ) -> Result<u64, String> {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| "audio host state unavailable")?;
        if let Some(host) = lifecycle.host.as_ref() {
            let current_generation = host.commands.session_generation();
            require_generation(expected_generation, current_generation)?;
            if host.diagnostics().device_failed {
                host.commands.session_transfer().abort_pending();
                abort_session_transfer(&state);
                let mut failed_host = lifecycle.host.take().unwrap();
                failed_host.shutdown();
                settle_host_commands(&mut failed_host, &state);
                lifecycle.recovery_session = failed_host.take_recovery_session();
                let next_generation = current_generation.saturating_add(1);
                let start = MonitoringHost::start_with_session(
                    HostConfig::default(),
                    lifecycle.recovery_session.as_ref(),
                );
                let mut host = start.map_err(|error| error.to_string())?;
                advance_host_to(&mut host, next_generation);
                let generation = host.commands.session_generation();
                lifecycle.generation = generation;
                lifecycle.recovery_session = None;
                lifecycle.host = Some(host);
                return Ok(generation);
            }
            let host = lifecycle.host.as_mut().unwrap();
            let notices = host.signals.acknowledge_capture_interruption();
            if notices
                .initial_recording_discarded_tracks
                .iter()
                .any(|v| *v)
                || notices.overdub_may_be_partial_tracks.iter().any(|v| *v)
            {
                host.commands.restart();
            }
            let generation = host.commands.session_generation();
            lifecycle.generation = generation;
            return Ok(generation);
        }
        require_generation(expected_generation, lifecycle.generation)?;
        let mut host = MonitoringHost::start_with_session(
            HostConfig::default(),
            lifecycle.recovery_session.as_ref(),
        )
        .map_err(|error| error.to_string())?;
        advance_host_to(&mut host, lifecycle.generation);
        let generation = host.commands.session_generation();
        lifecycle.generation = generation;
        lifecycle.recovery_session = None;
        lifecycle.host = Some(host);
        Ok(generation)
    }

    #[tauri::command]
    fn audio_host_stop(
        expected_generation: u64,
        state: State<'_, Arc<HostState>>,
    ) -> Result<u64, String> {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| "audio host state unavailable")?;
        let current_generation = lifecycle
            .host
            .as_ref()
            .map(|host| host.commands.session_generation())
            .unwrap_or(lifecycle.generation);
        require_generation(expected_generation, current_generation)?;
        if let Some(host) = lifecycle.host.as_ref() {
            host.commands.session_transfer().abort_pending();
        }
        abort_session_transfer(state.inner());
        if let Some(mut host) = lifecycle.host.take() {
            host.shutdown();
            settle_host_commands(&mut host, &state);
        }
        lifecycle.recovery_session = None;
        lifecycle.generation = current_generation.saturating_add(1);
        Ok(lifecycle.generation)
    }

    #[tauri::command]
    async fn audio_submit(
        command: UiCommand,
        expected_generation: u64,
        state: State<'_, Arc<HostState>>,
    ) -> Result<serde_json::Value, String> {
        let state = Arc::clone(state.inner());
        run_host_call(move || audio_submit_blocking(command, expected_generation, state.as_ref()))
            .await
            .map_err(|error| format!("audio command worker failed: {error}"))?
    }

    async fn run_host_call<T: Send + 'static>(
        operation: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(operation)
            .await
            .map_err(|error| error.to_string())
    }

    fn audio_submit_blocking(
        command: UiCommand,
        expected_generation: u64,
        state: &HostState,
    ) -> Result<serde_json::Value, String> {
        let command = AudioCommand::try_from(command)?;
        let _submission = state
            .submit_gate
            .lock()
            .map_err(|_| "audio command queue unavailable")?;
        let accepted = {
            let mut lifecycle = state
                .lifecycle
                .lock()
                .map_err(|_| "audio host state unavailable")?;
            let host = lifecycle
                .host
                .as_mut()
                .ok_or_else(|| "audio host is unavailable".to_string())?;
            let current_generation = host.commands.session_generation();
            require_generation(expected_generation, current_generation)?;
            let accepted = host
                .commands
                .submit_for_generation(command, expected_generation)
                .map_err(|reason| format!("command rejected: {reason:?}"))?;
            host.commands.flush(64);
            state
                .pending
                .lock()
                .map_err(|_| "audio command outcomes unavailable")?
                .insert(accepted.command_id, accepted.generation);
            accepted
        };
        loop {
            let outcome = {
                let mut lifecycle = state
                    .lifecycle
                    .lock()
                    .map_err(|_| "audio host state unavailable")?;
                if let Some(host) = lifecycle.host.as_mut() {
                    let mut matching = None;
                    while let Some(outcome) = host.commands.take_outcome() {
                        let command_id = outcome.command_id();
                        state
                            .pending
                            .lock()
                            .map_err(|_| "audio command outcomes unavailable")?
                            .remove(&command_id);
                        let value = outcome_json(outcome);
                        if command_id == accepted.command_id {
                            matching = Some(value);
                            break;
                        }
                        state
                            .terminal
                            .lock()
                            .map_err(|_| "audio command outcomes unavailable")?
                            .insert(command_id, value);
                    }
                    matching
                } else {
                    None
                }
            };
            if let Some(outcome) = outcome {
                return Ok(outcome);
            }
            if let Some(outcome) = state
                .terminal
                .lock()
                .map_err(|_| "audio command outcomes unavailable")?
                .remove(&accepted.command_id)
            {
                return Ok(outcome);
            }
            if state
                .lifecycle
                .lock()
                .map_err(|_| "audio host state unavailable")?
                .host
                .is_none()
            {
                state
                    .pending
                    .lock()
                    .map_err(|_| "audio command outcomes unavailable")?
                    .remove(&accepted.command_id);
                return Ok(stale_outcome_json(accepted.command_id, accepted.generation));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn require_generation(expected: u64, current: u64) -> Result<(), String> {
        if expected == current {
            Ok(())
        } else {
            Err(format!(
                "stale audio session generation: expected {expected}, current {current}"
            ))
        }
    }

    fn advance_host_to(host: &mut MonitoringHost, generation: u64) {
        advance_commands_to(&mut host.commands, generation);
    }

    fn advance_commands_to(commands: &mut CommandAdapter, generation: u64) {
        while commands.session_generation() < generation {
            commands.restart();
        }
    }

    fn settle_host_commands(host: &mut MonitoringHost, state: &HostState) {
        let mut outcomes = Vec::new();
        while let Some(outcome) = host.commands.take_outcome() {
            outcomes.push(outcome);
        }
        let mut pending = state
            .pending
            .lock()
            .expect("audio pending command list unavailable");
        let mut terminal = state
            .terminal
            .lock()
            .expect("audio command outcome cache unavailable");
        for outcome in outcomes {
            let command_id = outcome.command_id();
            pending.remove(&command_id);
            terminal.insert(command_id, outcome_json(outcome));
        }
        for (command_id, generation) in pending.drain() {
            terminal.insert(command_id, stale_outcome_json(command_id, generation));
        }
    }

    fn stale_outcome_json(command_id: u64, generation: u64) -> serde_json::Value {
        serde_json::json!({
            "commandId": command_id, "generation": generation, "status": "stale",
        })
    }

    fn outcome_json(outcome: CommandOutcome) -> serde_json::Value {
        match outcome {
            CommandOutcome::Applied {
                command_id,
                generation,
                application_frame,
                block_sequence,
            } => serde_json::json!({
                "commandId": command_id, "generation": generation, "status": "applied",
                "applicationFrame": application_frame, "blockSequence": block_sequence,
            }),
            CommandOutcome::Superseded {
                command_id,
                generation,
                replacement_command_id,
            } => serde_json::json!({
                "commandId": command_id, "generation": generation, "status": "superseded",
                "replacementCommandId": replacement_command_id,
            }),
            CommandOutcome::Stale {
                command_id,
                generation,
            } => serde_json::json!({
                "commandId": command_id, "generation": generation, "status": "stale",
            }),
            CommandOutcome::Failed {
                command_id,
                generation,
            } => serde_json::json!({
                "commandId": command_id, "generation": generation, "status": "failed",
                "error": "The engine rejected the command when it was applied.",
            }),
        }
    }

    #[tauri::command]
    fn audio_snapshot(state: State<'_, Arc<HostState>>) -> Result<serde_json::Value, String> {
        let mut lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| "audio host state unavailable")?;
        let Some(host) = lifecycle.host.as_mut() else {
            return Ok(idle_snapshot(lifecycle.generation));
        };
        let Some(snapshot) = host.latest_snapshot() else {
            return Ok(idle_snapshot(lifecycle.generation));
        };
        let generation = host.commands.session_generation();
        let diagnostics = host.diagnostics();
        let interrupted = diagnostics
            .pending_capture_interruption
            .initial_recording_discarded_tracks
            .iter()
            .any(|v| *v)
            || diagnostics
                .pending_capture_interruption
                .overdub_may_be_partial_tracks
                .iter()
                .any(|v| *v);
        let capture_interruption = if interrupted {
            let reason = match diagnostics.last_capture_discontinuity {
                Some(windows_audio_host::CaptureDiscontinuityReason::WasapiReported) => {
                    "wasapi-reported"
                }
                Some(windows_audio_host::CaptureDiscontinuityReason::CapturePacketGap) => {
                    "capture-packet-gap"
                }
                Some(windows_audio_host::CaptureDiscontinuityReason::CaptureQueueOverflow) => {
                    "capture-queue-overflow"
                }
                Some(windows_audio_host::CaptureDiscontinuityReason::RenderInputUnderflow) => {
                    "render-input-underflow"
                }
                Some(windows_audio_host::CaptureDiscontinuityReason::CaptureBacklogDiscarded) => {
                    "capture-backlog-discarded"
                }
                None => "capture-packet-gap",
            };
            let discarded = diagnostics
                .pending_capture_interruption
                .initial_recording_discarded_tracks
                .iter()
                .enumerate()
                .filter_map(|(id, discarded)| discarded.then_some(id))
                .collect::<Vec<_>>();
            let partial = diagnostics
                .pending_capture_interruption
                .overdub_may_be_partial_tracks
                .iter()
                .enumerate()
                .filter_map(|(id, partial)| partial.then_some(id))
                .collect::<Vec<_>>();
            serde_json::json!({
                "reason": reason,
                "initialRecordingDiscardedTracks": discarded,
                "overdubMayBePartialTracks": partial,
                "completedRecordingsRetained": true,
                "transportReset": true,
                "monitoringDisabled": true,
            })
        } else {
            serde_json::Value::Null
        };
        let tracks = snapshot.tracks.map(|track| serde_json::json!({
            "gain": track.gain, "muted": track.muted,
            "mode": if track.mode == PlaybackMode::Loop { "Loop" } else { "OneShot" },
            "canSetMode": track.can_set_mode, "canSetLoop": track.can_set_loop,
            "state": match track.state { TrackState::Empty => "Empty", TrackState::Recording => "Recording", TrackState::Playing => "Playing", TrackState::Stopped => "Stopped", TrackState::Overdubbing => "Overdubbing" },
            "capacitySamples": track.capacity_samples, "captureLimitSamples": track.capture_limit_samples,
            "capturedSamples": track.captured_samples, "canRecord": track.can_record,
            "canPlay": track.can_play, "canStop": track.can_stop,
            "lengthSamples": track.length_samples, "positionSamples": track.position_samples,
        }));
        let fx = snapshot.fx.map(|slot| match slot.config {
            FxConfig::None => serde_json::json!({ "config": { "type": "None" }, "transitioning": slot.transitioning, "removing": slot.removing }),
            FxConfig::LowPass { cutoff_hz, bypassed } => serde_json::json!({ "config": { "type": "LowPass", "cutoffHz": cutoff_hz, "bypassed": bypassed }, "transitioning": slot.transitioning, "removing": slot.removing }),
        });
        let status = host_status(diagnostics.device_failed, interrupted);
        let host_error = diagnostics
            .device_failed
            .then_some("A Windows audio device failed. Reinitialize audio to reopen the streams.");
        let response = serde_json::json!({
            "generation": generation,
            "engine": {
                "fx": fx, "masterGain": snapshot.master_gain,
                "transport": { "running": snapshot.transport_running, "positionSamples": snapshot.transport_position_samples, "cycleLengthSamples": snapshot.cycle_length_samples },
                "tracks": tracks, "monitoring": snapshot.monitoring,
                "processedFrames": host.rendered_frames(), "inputLevel": 0, "outputLevel": 0,
            },
            "host": { "inputDeviceId": null, "status": status, "error": host_error, "sampleRate": diagnostics.render.actual_sample_rate, "captureInterruption": capture_interruption },
        });
        if diagnostics.device_failed {
            host.commands.session_transfer().abort_pending();
            abort_session_transfer(state.inner());
        }
        lifecycle.generation = generation;
        Ok(response)
    }

    fn idle_snapshot(generation: u64) -> serde_json::Value {
        serde_json::json!({
            "generation": generation,
            "engine": { "masterGain": 1, "transport": { "running": false, "positionSamples": 0, "cycleLengthSamples": 0 },
                "tracks": [empty_track(), empty_track()], "monitoring": false, "processedFrames": 0, "inputLevel": 0, "outputLevel": 0,
                "fx": std::array::from_fn::<_, 4, _>(|_| serde_json::json!({ "config": { "type": "None" }, "transitioning": false, "removing": false })) },
            "host": { "inputDeviceId": null, "status": "idle", "error": null, "sampleRate": null },
        })
    }

    fn fx_json(config: FxConfig) -> serde_json::Value {
        match config {
            FxConfig::None => serde_json::json!({ "type": "None" }),
            FxConfig::LowPass {
                cutoff_hz,
                bypassed,
            } => serde_json::json!({
                "type": "LowPass", "cutoffHz": cutoff_hz, "bypassed": bypassed
            }),
        }
    }

    fn export_manifest(sample_rate: u32, metadata: ImportMetadata) -> serde_json::Value {
        serde_json::json!({
            "format": "LoopBeatsSession", "version": 2, "sampleRate": sample_rate,
            "cycleLengthSamples": metadata.cycle_length, "masterGain": metadata.master_gain,
            "inputFx": fx_json(metadata.fx[0]), "masterFx": fx_json(metadata.fx[3]),
            "tracks": metadata.tracks.iter().enumerate().map(|(id, track)| serde_json::json!({
                "id": id, "mode": if track.mode == PlaybackMode::Loop { "Loop" } else { "OneShot" },
                "gain": track.gain, "muted": track.muted, "lengthSamples": track.length,
                "audioPath": (track.length > 0).then(|| format!("tracks/{id}.wav")),
                "fx": fx_json(metadata.fx[id + 1]),
            })).collect::<Vec<_>>(),
        })
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TransferTrack {
        id: usize,
        mode: String,
        gain: f32,
        muted: bool,
        length_samples: usize,
        audio_path: Option<String>,
        fx: FxWire,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct TransferManifest {
        format: String,
        version: u8,
        sample_rate: u32,
        cycle_length_samples: usize,
        master_gain: f32,
        input_fx: FxWire,
        master_fx: FxWire,
        tracks: [TransferTrack; 2],
    }

    fn import_metadata(manifest: TransferManifest) -> Result<(u32, ImportMetadata), String> {
        if manifest.format != "LoopBeatsSession" || manifest.version != 2 {
            return Err("unsupported session format".into());
        }
        let mut tracks = [ImportTrack {
            length: 0,
            mode: PlaybackMode::Loop,
            gain: 1.0,
            muted: false,
        }; 2];
        let mut fx = [FxConfig::None; 4];
        fx[0] = manifest.input_fx.into();
        fx[3] = manifest.master_fx.into();
        for (id, track) in manifest.tracks.into_iter().enumerate() {
            if track.id != id {
                return Err("invalid track ordering".into());
            }
            let expected_path = (track.length_samples > 0).then(|| format!("tracks/{id}.wav"));
            if track.audio_path != expected_path {
                return Err("track audio path does not match its length".into());
            }
            tracks[id] = ImportTrack {
                length: track.length_samples,
                mode: match track.mode.as_str() {
                    "Loop" => PlaybackMode::Loop,
                    "OneShot" => PlaybackMode::OneShot,
                    _ => return Err("invalid playback mode".into()),
                },
                gain: track.gain,
                muted: track.muted,
            };
            fx[id + 1] = track.fx.into();
        }
        Ok((
            manifest.sample_rate,
            ImportMetadata {
                fx,
                cycle_length: manifest.cycle_length_samples,
                master_gain: manifest.master_gain,
                tracks,
            },
        ))
    }

    fn current_transfer(state: &HostState) -> Result<SessionTransfer, String> {
        state
            .lifecycle
            .lock()
            .map_err(|_| "audio host state unavailable")?
            .host
            .as_ref()
            .map(|host| host.commands.session_transfer())
            .ok_or_else(|| "audio host is unavailable".into())
    }

    fn abort_session_transfer(state: &HostState) {
        if let Ok(mut operation) = state.session_transfer.lock() {
            match &*operation {
                TransferOperation::Export { transfer, .. }
                | TransferOperation::Import { transfer, .. } => transfer.abort_pending(),
                TransferOperation::Idle => {}
            }
            *operation = TransferOperation::Idle;
        }
    }

    #[tauri::command]
    async fn audio_session_export_begin(
        state: State<'_, Arc<HostState>>,
    ) -> Result<serde_json::Value, String> {
        let state = Arc::clone(state.inner());
        run_host_call(move || {
            let transfer = current_transfer(state.as_ref())?;
            let _gate = state
                .transfer_gate
                .lock()
                .map_err(|_| "session transfer unavailable")?;
            if !matches!(
                &*state
                    .session_transfer
                    .lock()
                    .map_err(|_| "session transfer unavailable")?,
                TransferOperation::Idle
            ) {
                return Err("another session transfer is already active".into());
            }
            let (rate, metadata, revisions) = transfer.begin_export()?;
            let token = state
                .next_transfer_id
                .fetch_add(1, Ordering::Relaxed)
                .max(1);
            *state
                .session_transfer
                .lock()
                .map_err(|_| "session transfer unavailable")? = TransferOperation::Export {
                token,
                transfer,
                revisions,
            };
            Ok(serde_json::json!({ "token": token, "manifest": export_manifest(rate, metadata) }))
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[tauri::command]
    async fn audio_session_export_read(
        token: u64,
        track: usize,
        offset: usize,
        frames: usize,
        state: State<'_, Arc<HostState>>,
    ) -> Result<Vec<f32>, String> {
        let state = Arc::clone(state.inner());
        run_host_call(move || {
            let _gate = state
                .transfer_gate
                .lock()
                .map_err(|_| "session transfer unavailable")?;
            let (transfer, revision) = match &*state
                .session_transfer
                .lock()
                .map_err(|_| "session transfer unavailable")?
            {
                TransferOperation::Export {
                    token: active,
                    transfer,
                    revisions,
                } if *active == token && track < 2 => (transfer.clone(), revisions[track]),
                _ => return Err("stale session export operation".into()),
            };
            transfer.read_export_chunk(track, revision, offset, frames)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[tauri::command]
    async fn audio_session_export_end(
        token: u64,
        state: State<'_, Arc<HostState>>,
    ) -> Result<(), String> {
        let state = Arc::clone(state.inner());
        run_host_call(move || {
            let _gate = state
                .transfer_gate
                .lock()
                .map_err(|_| "session transfer unavailable")?;
            let mut operation = state.session_transfer.lock().map_err(|_| "session transfer unavailable")?;
            if matches!(&*operation, TransferOperation::Export { token: active, .. } if *active == token) { *operation = TransferOperation::Idle; Ok(()) }
            else { Err("stale session export operation".into()) }
        }).await.map_err(|error| error.to_string())?
    }

    #[tauri::command]
    async fn audio_session_import_begin(
        manifest: TransferManifest,
        state: State<'_, Arc<HostState>>,
    ) -> Result<u64, String> {
        let state = Arc::clone(state.inner());
        run_host_call(move || {
            let (rate, metadata) = import_metadata(manifest)?;
            let transfer = current_transfer(state.as_ref())?;
            let _gate = state
                .transfer_gate
                .lock()
                .map_err(|_| "session transfer unavailable")?;
            let current_rate = state
                .lifecycle
                .lock()
                .map_err(|_| "audio host state unavailable")?
                .host
                .as_ref()
                .map(|host| host.diagnostics().render.actual_sample_rate)
                .ok_or_else(|| "audio host is unavailable".to_string())?;
            if rate != current_rate {
                return Err("session sample rate does not match the Windows engine".into());
            }
            if !matches!(
                &*state
                    .session_transfer
                    .lock()
                    .map_err(|_| "session transfer unavailable")?,
                TransferOperation::Idle
            ) {
                return Err("another session transfer is already active".into());
            }
            transfer.begin_import(metadata)?;
            let token = state
                .next_transfer_id
                .fetch_add(1, Ordering::Relaxed)
                .max(1);
            *state
                .session_transfer
                .lock()
                .map_err(|_| "session transfer unavailable")? =
                TransferOperation::Import { token, transfer };
            Ok(token)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[tauri::command]
    async fn audio_session_import_write(
        token: u64,
        track: usize,
        offset: usize,
        samples: Vec<f32>,
        state: State<'_, Arc<HostState>>,
    ) -> Result<(), String> {
        if samples.is_empty() || samples.len() > 2048 {
            return Err("session transfer chunks must contain 1 to 2,048 frames".into());
        }
        let state = Arc::clone(state.inner());
        run_host_call(move || {
            let _gate = state
                .transfer_gate
                .lock()
                .map_err(|_| "session transfer unavailable")?;
            let transfer = match &*state
                .session_transfer
                .lock()
                .map_err(|_| "session transfer unavailable")?
            {
                TransferOperation::Import {
                    token: active,
                    transfer,
                } if *active == token => transfer.clone(),
                _ => return Err("stale session import operation".into()),
            };
            transfer.write_import_chunk(track, offset, &samples)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[tauri::command]
    async fn audio_session_import_commit(
        token: u64,
        state: State<'_, Arc<HostState>>,
    ) -> Result<(), String> {
        let state = Arc::clone(state.inner());
        run_host_call(move || {
            let _gate = state
                .transfer_gate
                .lock()
                .map_err(|_| "session transfer unavailable")?;
            let transfer = match &*state
                .session_transfer
                .lock()
                .map_err(|_| "session transfer unavailable")?
            {
                TransferOperation::Import {
                    token: active,
                    transfer,
                } if *active == token => transfer.clone(),
                _ => return Err("stale session import operation".into()),
            };
            transfer.commit_import()?;
            *state
                .session_transfer
                .lock()
                .map_err(|_| "session transfer unavailable")? = TransferOperation::Idle;
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[tauri::command]
    async fn audio_session_cancel(
        token: u64,
        state: State<'_, Arc<HostState>>,
    ) -> Result<(), String> {
        let state = Arc::clone(state.inner());
        run_host_call(move || {
            let _gate = state
                .transfer_gate
                .lock()
                .map_err(|_| "session transfer unavailable")?;
            let transfer = {
                let mut operation = state
                    .session_transfer
                    .lock()
                    .map_err(|_| "session transfer unavailable")?;
                match &*operation {
                    TransferOperation::Export { token: active, .. } if *active == token => {
                        *operation = TransferOperation::Idle;
                        return Ok(());
                    }
                    TransferOperation::Import {
                        token: active,
                        transfer,
                    } if *active == token => {
                        let transfer = transfer.clone();
                        *operation = TransferOperation::Idle;
                        transfer
                    }
                    _ => return Err("stale session transfer operation".into()),
                }
            };
            transfer.cancel_import()
        })
        .await
        .map_err(|error| error.to_string())?
    }

    fn host_status(device_failed: bool, interrupted: bool) -> &'static str {
        if device_failed {
            "error"
        } else if interrupted {
            "interrupted"
        } else {
            "ready"
        }
    }

    fn empty_track() -> serde_json::Value {
        serde_json::json!({ "gain": 1, "muted": false, "mode": "Loop", "canSetMode": false, "canSetLoop": false, "state": "Empty",
            "capacitySamples": 0, "captureLimitSamples": 0, "capturedSamples": 0, "canRecord": false, "canPlay": false, "canStop": false,
            "lengthSamples": 0, "positionSamples": 0 })
    }

    pub fn run() {
        tauri::Builder::default()
            .manage(Arc::new(HostState::default()))
            .invoke_handler(tauri::generate_handler![
                audio_capabilities,
                audio_host_start,
                audio_host_stop,
                audio_submit,
                audio_snapshot,
                audio_session_export_begin,
                audio_session_export_read,
                audio_session_export_end,
                audio_session_import_begin,
                audio_session_import_write,
                audio_session_import_commit,
                audio_session_cancel
            ])
            .run(tauri::generate_context!())
            .expect("failed to run LoopBeats Windows shell");
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn stale_bridge_generation_is_rejected() {
            assert!(require_generation(4, 5).is_err());
            assert!(require_generation(5, 5).is_ok());
        }

        #[test]
        fn device_failure_is_visible_as_an_error_even_without_capture_notices() {
            assert_eq!(host_status(true, false), "error");
            assert_eq!(host_status(false, true), "interrupted");
            assert_eq!(host_status(false, false), "ready");
        }

        #[test]
        fn recovered_host_generation_is_newer_than_the_failed_host() {
            let (mut commands, _processor) = native_audio_host::Processor::controlled(16, 48_000);
            advance_commands_to(&mut commands, 4);
            assert_eq!(commands.session_generation(), 4);
        }

        #[test]
        fn waiting_command_worker_does_not_block_later_bridge_dispatch() {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let waiting = tauri::async_runtime::spawn(run_host_call(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }));
            started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("blocked command worker starts");

            let later_result = tauri::async_runtime::block_on(run_host_call(|| 42))
                .expect("a later bridge call runs while the first waits");
            assert_eq!(later_result, 42);
            release_tx.send(()).unwrap();
            tauri::async_runtime::block_on(waiting)
                .expect("waiting command worker joins")
                .expect("waiting command completes");
        }
    }
}

#[cfg(windows)]
fn main() {
    windows_app::run();
}

#[cfg(not(windows))]
fn main() {}
