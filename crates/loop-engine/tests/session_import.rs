use loop_engine::{FxConfig, ImportMetadata, ImportTrack, LoopEngine, PlaybackMode, TrackState};

#[test]
fn staged_import_replaces_both_tracks_silently_and_replays_exact_samples() {
    let mut engine = LoopEngine::with_capacity(8);
    engine.record(0);
    engine.process(&[0.1, 0.2], &mut [0.0; 2]);
    engine.record(0);
    let metadata = ImportMetadata {
        fx: [FxConfig::None; 4],
        cycle_length: 3,
        master_gain: 1.0,
        tracks: [
            ImportTrack {
                length: 3,
                mode: PlaybackMode::Loop,
                gain: 1.0,
                muted: false,
            },
            ImportTrack {
                length: 2,
                mode: PlaybackMode::OneShot,
                gain: 1.0,
                muted: false,
            },
        ],
    };
    let revision = engine.command_revision();
    assert!(engine.begin_import(metadata, revision));
    assert!(engine.write_import(0, 0, &[0.25, -0.5, 0.75]));
    assert!(!engine.commit_import());
    assert_eq!(engine.snapshot().tracks[0].length_samples, 2);
    assert!(engine.write_import(1, 0, &[0.125, -0.25]));
    assert!(engine.commit_import());
    let snapshot = engine.snapshot();
    assert!(snapshot
        .tracks
        .iter()
        .all(|t| t.state == TrackState::Stopped));
    assert_eq!(snapshot.transport_position_samples, 0);
    assert!(!snapshot.transport_running);
    assert!(!engine.monitoring());
    assert!(snapshot
        .fx
        .iter()
        .all(|s| s.config == FxConfig::None && !s.transitioning && !s.removing));
    engine.play(0);
    let mut output = [0.0; 4];
    engine.process(&[0.0; 4], &mut output);
    assert_eq!(output, [0.25, -0.5, 0.75, 0.25]);
}

#[test]
fn failed_or_stale_staging_retains_live_samples_and_retry_works() {
    let mut engine = LoopEngine::with_capacity(4);
    engine.record(0);
    engine.process(&[0.25, -0.5], &mut [0.0; 2]);
    engine.record(0);
    let metadata = ImportMetadata {
        fx: [FxConfig::None; 4],
        cycle_length: 2,
        master_gain: 1.0,
        tracks: [ImportTrack {
            length: 2,
            mode: PlaybackMode::Loop,
            gain: 1.0,
            muted: false,
        }; 2],
    };
    let revision = engine.command_revision();
    assert!(engine.begin_import(metadata, revision));
    assert!(!engine.write_import(0, 1, &[0.75]));
    assert!(!engine.write_import(0, 0, &[f32::NAN]));
    assert!(engine.write_import(0, 0, &[0.75, 0.5]));
    assert!(!engine.write_import(0, 0, &[0.75]));
    engine.set_track_mute(1, true);
    assert!(!engine.write_import(1, 0, &[0.5, 0.75]));
    assert!(!engine.commit_import());
    engine.cancel_import();
    let mut saved = [0.0; 2];
    assert!(engine.read_recording(0, engine.recording_revision(0), 0, &mut saved));
    assert_eq!(saved, [0.25, -0.5]);
    assert_eq!(engine.snapshot().tracks[1].state, TrackState::Empty);
    assert!(engine.begin_import(metadata, engine.command_revision()));
    for id in 0..2 {
        assert!(engine.write_import(id, 0, &[0.5, 0.75]));
    }
    assert!(engine.commit_import());
    assert!(!engine.commit_import());
}

#[test]
fn import_rejects_incompatible_metadata_and_capture() {
    let mut engine = LoopEngine::with_capacity(4);
    let metadata = ImportMetadata {
        fx: [FxConfig::None; 4],
        cycle_length: 2,
        master_gain: 1.0,
        tracks: [ImportTrack {
            length: 3,
            mode: PlaybackMode::Loop,
            gain: 1.0,
            muted: false,
        }; 2],
    };
    assert!(!engine.begin_import(metadata, engine.command_revision()));
    let mut valid = metadata;
    valid.tracks[0].length = 2;
    valid.tracks[1].length = 0;
    engine.record(0);
    assert!(!engine.begin_import(valid, engine.command_revision()));
}

#[test]
fn fx_restore_is_atomic_fresh_and_rejected_by_a_late_valid_edit() {
    let mut engine = LoopEngine::with_capacity(512);
    let fx = FxConfig::LowPass {
        cutoff_hz: 1000.0,
        bypassed: false,
    };
    let metadata = ImportMetadata {
        fx: [fx, FxConfig::None, fx, FxConfig::None],
        cycle_length: 1,
        master_gain: 1.0,
        tracks: [ImportTrack {
            length: 0,
            mode: PlaybackMode::Loop,
            gain: 1.0,
            muted: false,
        }; 2],
    };
    engine.set_monitoring(true);
    assert!(engine.begin_import(metadata, engine.command_revision()));
    engine.set_input_fx(fx).unwrap();
    assert!(!engine.commit_import());
    assert!(engine.monitoring());
    engine.cancel_import();
    engine.process(&[0.25; 512], &mut [0.0; 512]);
    assert!(engine.begin_import(metadata, engine.command_revision()));
    assert!(engine.commit_import());
    assert_eq!(engine.snapshot().fx.map(|s| s.config), metadata.fx);
    assert!(engine
        .snapshot()
        .fx
        .iter()
        .all(|s| !s.transitioning && !s.removing));
    engine.set_monitoring(true);
    let mut output = [0.0; 4];
    engine.process(&[0.5, 0.0, 0.0, 0.0], &mut output);
    for (actual, expected) in output.iter().zip([
        0.00195806333027369,
        0.00747067946653054,
        0.01389273310983166,
        0.01901187277242247,
    ]) {
        assert!((f64::from(*actual) - expected).abs() < 1e-7);
    }
    let mut invalid = metadata;
    invalid.fx[2] = FxConfig::LowPass {
        cutoff_hz: f64::INFINITY,
        bypassed: true,
    };
    assert!(!engine.begin_import(invalid, engine.command_revision()));
    assert_eq!(engine.snapshot().fx.map(|s| s.config), metadata.fx);
}
