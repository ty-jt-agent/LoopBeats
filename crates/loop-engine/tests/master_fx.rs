use loop_engine::{FxConfig, LoopEngine};

fn low_pass(cutoff_hz: f64) -> FxConfig {
    FxConfig::LowPass {
        cutoff_hz,
        bypassed: false,
    }
}

fn master_filter_engine() -> LoopEngine {
    let mut engine = LoopEngine::with_capacity(256);
    engine.set_master_fx(low_pass(1000.0)).unwrap();
    engine.process(&[0.0; 512], &mut [0.0; 512]);
    engine
}

fn playing_track() -> LoopEngine {
    let mut engine = master_filter_engine();
    engine.record(0);
    engine.process(&[0.5, 0.0, 0.0, 0.0], &mut [0.0; 4]);
    engine.record(0);
    engine
}

#[test]
fn master_filter_processes_the_mix_after_track_fx_without_mutating_recordings() {
    let mut engine = playing_track();
    engine.set_monitoring(true);
    let mut output = [0.0; 4];
    engine.process(&[0.25; 4], &mut output);

    assert!((f64::from(output[0]) - 0.002937094995410537).abs() < 1e-8);
    assert!(output[1] > 0.0);
    let mut stored = [0.0; 4];
    assert!(engine.read_recording(0, engine.recording_revision(0), 0, &mut stored));
    assert_eq!(stored, [0.5, 0.0, 0.0, 0.0]);
    assert_eq!(engine.snapshot().fx[3].config, low_pass(1000.0));
}

#[test]
fn master_gain_zero_is_exact_silence_without_freezing_master_history() {
    let mut reference = playing_track();
    let mut silent = playing_track();
    for engine in [&mut reference, &mut silent] {
        engine.set_monitoring(true);
        engine.process(&[0.5; 8], &mut [0.0; 8]);
        engine.set_monitoring(false);
    }
    silent.set_master_gain(0.0);
    let mut silence = [1.0; 64];
    silent.process(&[0.0; 64], &mut silence);
    reference.process(&[0.0; 64], &mut [0.0; 64]);
    assert_eq!(silence, [0.0; 64]);
    assert!(!silent.snapshot().audio_failed);

    silent.set_master_gain(1.0);
    let mut expected = [0.0; 64];
    let mut actual = [0.0; 64];
    reference.process(&[0.0; 64], &mut expected);
    silent.process(&[0.0; 64], &mut actual);
    assert_eq!(actual, expected);
    assert!(actual.iter().any(|sample| sample.abs() > 1e-8));
}

#[test]
fn local_track_actions_preserve_shared_master_residuals_and_global_stop_clears_them() {
    for action in 0..4 {
        let mut reference = master_filter_engine();
        let mut local = master_filter_engine();
        for engine in [&mut reference, &mut local] {
            engine.set_monitoring(true);
            engine.process(&[0.5; 8], &mut [0.0; 8]);
            engine.set_monitoring(false);
        }
        match action {
            0 => local.stop_track(0),
            1 => local.clear(0),
            2 => local.set_track_mute(0, true),
            _ => local.set_track_gain(0, 0.0),
        }
        let mut expected = [0.0; 64];
        let mut actual = [0.0; 64];
        reference.process(&[0.0; 64], &mut expected);
        local.process(&[0.0; 64], &mut actual);
        assert_eq!(actual, expected, "local action {action}");
        assert!(actual.iter().any(|sample| sample.abs() > 1e-8));
    }

    let mut stopped = playing_track();
    stopped.set_monitoring(true);
    stopped.process(&[0.5; 8], &mut [0.0; 8]);
    stopped.stop_transport();
    assert_eq!(stopped.snapshot().fx[3].config, low_pass(1000.0));
    assert!(!stopped.snapshot().fx[3].transitioning);
    stopped.set_monitoring(false);
    let mut output = [1.0; 64];
    stopped.process(&[0.0; 64], &mut output);
    assert_eq!(output, [0.0; 64]);
}

#[test]
fn global_stop_clears_history_but_keeps_monitoring_and_configuration() {
    let mut engine = playing_track();
    engine.set_monitoring(true);
    engine.process(&[0.5; 8], &mut [0.0; 8]);
    engine.stop_transport();
    assert!(engine.monitoring());
    assert_eq!(engine.snapshot().fx[3].config, low_pass(1000.0));
    assert!(!engine.snapshot().fx[3].transitioning);

    let mut output = [0.0; 4];
    engine.process(&[0.5, 0.0, 0.0, 0.0], &mut output);
    assert!((f64::from(output[0]) - 0.5 * 0.003916126660547383).abs() < 1e-8);
    assert!(output[1] > 0.0);
    assert_eq!(
        engine.snapshot().tracks[0].state,
        loop_engine::TrackState::Stopped
    );
}

#[test]
fn stopping_one_track_leaves_the_other_track_contributing_through_master_fx() {
    let mut engine = playing_track();
    engine.record(1);
    engine.process(&[0.25; 4], &mut [0.0; 4]);
    assert_eq!(
        engine.snapshot().tracks[1].state,
        loop_engine::TrackState::Playing
    );
    engine.stop_track(0);
    let mut output = [0.0; 16];
    engine.process(&[0.0; 16], &mut output);
    assert_eq!(
        engine.snapshot().tracks[0].state,
        loop_engine::TrackState::Stopped
    );
    assert_eq!(
        engine.snapshot().tracks[1].state,
        loop_engine::TrackState::Playing
    );
    assert!(output.iter().any(|sample| sample.abs() > 1e-5));
}

#[test]
fn reset_defaults_fx_and_monitoring_while_retaining_track_preferences() {
    let mut engine = master_filter_engine();
    engine.set_monitoring(true);
    engine.set_mode(0, loop_engine::PlaybackMode::OneShot);
    engine.set_track_gain(0, 0.4);
    engine.set_track_mute(0, true);
    engine.set_track_fx(0, low_pass(500.0)).unwrap();
    engine.set_input_fx(low_pass(300.0)).unwrap();
    engine.reset();

    let snapshot = engine.snapshot();
    assert!(!engine.monitoring());
    assert_eq!(
        snapshot.fx[0].config,
        FxConfig::LowPass {
            cutoff_hz: 20000.0,
            bypassed: true
        }
    );
    assert_eq!(
        snapshot.fx[1].config,
        FxConfig::LowPass {
            cutoff_hz: 20000.0,
            bypassed: true
        }
    );
    assert_eq!(
        snapshot.fx[3].config,
        FxConfig::LowPass {
            cutoff_hz: 20000.0,
            bypassed: true
        }
    );
    assert_eq!(snapshot.tracks[0].mode, loop_engine::PlaybackMode::OneShot);
    assert_eq!(snapshot.tracks[0].gain, 0.4);
    assert!(snapshot.tracks[0].muted);
}

#[test]
fn interruption_retains_effect_targets_and_overdub_additions_with_fresh_history() {
    let mut engine = playing_track();
    engine.set_track_fx(0, low_pass(500.0)).unwrap();
    engine.set_monitoring(true);
    engine.record(0);
    engine.process(&[0.25], &mut [0.0]);
    engine.interrupt();

    let snapshot = engine.snapshot();
    assert_eq!(snapshot.tracks[0].state, loop_engine::TrackState::Stopped);
    assert!(!engine.monitoring());
    assert_eq!(snapshot.fx[1].config, low_pass(500.0));
    assert_eq!(snapshot.fx[3].config, low_pass(1000.0));
    assert!(!snapshot.fx[1].transitioning);
    assert!(!snapshot.fx[3].transitioning);
    let mut samples = [0.0; 4];
    assert!(engine.read_recording(0, engine.recording_revision(0), 0, &mut samples));
    assert_eq!(samples, [0.75, 0.0, 0.0, 0.0]);
}
