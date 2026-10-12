use loop_engine::{FxConfig, LoopEngine, PlaybackMode};

fn filter(cutoff_hz: f64) -> FxConfig {
    FxConfig::LowPass {
        cutoff_hz,
        bypassed: false,
    }
}
fn stored(engine: &LoopEngine, id: usize, frames: usize) -> Vec<f32> {
    let mut samples = vec![0.0; frames];
    assert!(engine.read_recording(id, engine.recording_revision(id), 0, &mut samples));
    samples
}

#[test]
fn independent_track_filter_changes_only_playback_and_precedes_gain_mute() {
    let mut engine = LoopEngine::with_capacity(512);
    engine.record(0);
    engine.process(&[0.5, 0.0, 0.0, 0.0], &mut [0.0; 4]);
    engine.record(0);
    engine.record(1);
    engine.process(&[0.25; 4], &mut [0.0; 4]);
    engine.set_track_fx(0, filter(1000.0)).unwrap();
    engine.stop_transport();
    engine.play(0);
    engine.play(1);
    engine.set_track_gain(0, 0.5);
    let mut output = [0.0; 4];
    engine.process(&[0.0; 4], &mut output);
    for (actual, expected) in output.iter().zip([
        0.25097903166513685,
        0.2537353397332653,
        0.2569463665549158,
        0.2595059363862112,
    ]) {
        assert!((f64::from(*actual) - expected).abs() < 1e-7);
    }
    assert_eq!(stored(&engine, 0, 4), [0.5, 0.0, 0.0, 0.0]);
    assert_eq!(stored(&engine, 1, 4), [0.25; 4]);
    assert!(matches!(
        engine.snapshot().fx[2].config,
        FxConfig::LowPass { bypassed: true, .. }
    ));
}

#[test]
fn one_sample_one_shot_contributes_filtered_final_sample_then_clears_on_end_and_retrigger() {
    let mut engine = LoopEngine::with_capacity(512);
    engine.set_mode(0, PlaybackMode::OneShot);
    engine.set_track_fx(0, filter(1000.0)).unwrap();
    engine.record(0);
    engine.process(&[0.5], &mut [0.0]);
    engine.record(0);
    let mut output = [0.0; 3];
    engine.process(&[0.0; 3], &mut output);
    assert!((output[0] - 0.0019580633).abs() < 1e-8);
    assert_eq!(&output[1..], &[0.0, 0.0]);
    engine.play(0);
    engine.process(&[0.0; 3], &mut output);
    assert!((output[0] - 0.0019580633).abs() < 1e-8);
    assert_eq!(&output[1..], &[0.0, 0.0]);
    assert!(!engine.snapshot().fx[1].transitioning);
    assert_eq!(stored(&engine, 0, 1), [0.5]);
}

fn playing() -> LoopEngine {
    let mut engine = LoopEngine::with_capacity(1024);
    engine.record(0);
    let mut source = [0.0; 1024];
    source[0] = 0.5;
    engine.process(&source, &mut [0.0; 1024]);
    engine.set_track_fx(0, filter(1000.0)).unwrap();
    engine.stop_transport();
    engine.play(0);
    engine
}

#[test]
fn mute_and_zero_gain_keep_warm_history_phase_and_live_ramps_advancing() {
    for zero_gain in [false, true] {
        let mut reference = playing();
        let mut silent = playing();
        if zero_gain {
            silent.set_track_gain(0, 0.0);
        } else {
            silent.set_track_mute(0, true);
        }
        reference.set_track_fx(0, filter(20.0)).unwrap();
        silent.set_track_fx(0, filter(20.0)).unwrap();
        let mut muted = [0.0; 512];
        reference.process(&[], &mut [0.0; 512]);
        silent.process(&[], &mut muted);
        assert_eq!(muted, [0.0; 512]);
        assert_eq!(silent.snapshot().transport_position_samples, 512);
        assert!(!silent.snapshot().fx[1].transitioning);
        if zero_gain {
            silent.set_track_gain(0, 1.0);
        } else {
            silent.set_track_mute(0, false);
        }
        let mut expected = [0.0; 128];
        let mut actual = [0.0; 128];
        reference.process(&[], &mut expected);
        silent.process(&[], &mut actual);
        assert_eq!(actual, expected);
        assert!(actual.iter().any(|s| s.abs() > 1e-8));
    }
}

#[test]
fn overdub_stores_raw_sum_even_muted_and_filters_current_sum_once() {
    let mut engine = playing();
    engine.set_track_mute(0, true);
    engine.record(0);
    engine.process(&[1.5; 1024], &mut [0.0; 1024]);
    engine.record(0);
    let samples = stored(&engine, 0, 1024);
    assert_eq!(samples[0], 2.0);
    assert!(samples[1..].iter().all(|s| *s == 1.5));
    engine.set_track_mute(0, false);
    engine.stop_track(0);
    engine.play(0);
    let mut output = [0.0; 4];
    engine.process(&[], &mut output);
    // Independent superposition: impulse(2) plus the response to 1.5 beginning at sample 1.
    for (actual, expected) in output.iter().zip([
        0.00783225332109476,
        0.03575690785700323,
        0.08385716082973933,
        0.14601191880810432,
    ]) {
        assert!((f64::from(*actual) - expected).abs() < 1e-7);
    }
}

#[test]
fn local_stop_clear_and_generation_reuse_snap_targets_without_touching_other_slots() {
    let mut engine = playing();
    engine.set_input_fx(filter(200.0)).unwrap();
    engine.set_track_fx(1, filter(300.0)).unwrap();
    engine.set_track_fx(0, filter(20.0)).unwrap();
    engine.process(&[0.25; 5], &mut [0.0; 5]);
    let other = [
        engine.snapshot().fx[0],
        engine.snapshot().fx[2],
        engine.snapshot().fx[3],
    ];
    engine.stop_track(0);
    assert!(!engine.snapshot().fx[1].transitioning);
    assert_eq!(
        [
            engine.snapshot().fx[0],
            engine.snapshot().fx[2],
            engine.snapshot().fx[3]
        ],
        other
    );
    engine.set_track_fx(0, FxConfig::None).unwrap();
    engine.clear(0);
    assert_eq!(engine.snapshot().fx[1].config, FxConfig::None);
    assert!(!engine.snapshot().fx[1].removing);
    engine
        .set_track_fx(
            0,
            FxConfig::LowPass {
                cutoff_hz: 20000.0,
                bypassed: true,
            },
        )
        .unwrap();
    engine.process(&[], &mut [0.0; 512]);
    assert!(matches!(
        engine.snapshot().fx[1].config,
        FxConfig::LowPass {
            cutoff_hz: 20000.0,
            bypassed: true
        }
    ));
    let revision = engine.command_revision();
    assert!(engine.set_track_fx(2, filter(1000.0)).is_err());
    assert!(engine.set_track_fx(0, filter(f64::NAN)).is_err());
    assert_eq!(engine.command_revision(), revision);
}

#[test]
fn loop_wrap_and_an_unavailable_play_do_not_restart_filter_history() {
    let mut engine = LoopEngine::with_capacity(512);
    engine.record(0);
    engine.process(&[0.5], &mut [0.0]);
    engine.record(0);
    engine.set_track_fx(0, filter(1000.0)).unwrap();
    engine.stop_transport();
    engine.play(0);
    let mut first = [0.0; 2];
    engine.process(&[], &mut first);
    engine.play(0); // Already-playing Loop PLAY is unavailable and preserves state.
    let mut next = [0.0; 2];
    engine.process(&[], &mut next);
    for (actual, expected) in first.into_iter().chain(next).zip([
        0.00195806333027369,
        0.00942874279680423,
        0.02332147590663589,
        0.04233334867905836,
    ]) {
        assert!((f64::from(actual) - expected).abs() < 1e-7);
    }
}

#[test]
fn local_stop_and_clear_preserve_live_input_history() {
    for clear in [false, true] {
        let mut reference = playing();
        let mut local = playing();
        for engine in [&mut reference, &mut local] {
            engine.set_track_mute(0, true);
            engine.set_input_fx(filter(1000.0)).unwrap();
            engine.stop_transport();
            engine.play(0);
            engine.set_monitoring(true);
            engine.process(&[0.5], &mut [0.0]);
        }
        if clear {
            local.clear(0);
        } else {
            local.stop_track(0);
        }
        let mut expected = [0.0; 128];
        let mut actual = [0.0; 128];
        reference.process(&[], &mut expected);
        local.process(&[], &mut actual);
        assert_eq!(actual, expected);
        assert!(actual.iter().any(|s| s.abs() > 1e-8));
    }
}

#[test]
fn finite_overrange_track_filter_retains_headroom_until_master_gain_and_clamp() {
    let mut engine = LoopEngine::with_capacity(16);
    engine.record(0);
    engine.process(&[f32::MAX; 4], &mut [0.0; 4]);
    engine.record(0);
    engine.set_track_fx(0, filter(20000.0)).unwrap();
    engine.stop_transport();
    engine.play(0);
    engine.set_master_gain(0.0);
    let mut output = [1.0; 16];
    engine.process(&[], &mut output);
    assert_eq!(output, [0.0; 16]);
    assert!(!engine.snapshot().audio_failed);
    engine.set_master_gain(1.0);
    engine.process(&[], &mut output);
    assert_eq!(output, [1.0; 16]);
    assert_eq!(stored(&engine, 0, 4), [f32::MAX; 4]);
}

#[test]
fn live_overdub_filters_current_sum_and_finishing_keeps_continuous_history() {
    let mut engine = playing();
    let mut reference = LoopEngine::with_capacity(1024);
    reference.set_input_fx(filter(1000.0)).unwrap();
    reference.stop_transport();
    reference.set_monitoring(true);
    engine.record(0);
    let mut effective = [0.125; 1024];
    effective[0] = 0.625;
    let mut actual = [0.0; 1024];
    let mut expected = [0.0; 1024];
    engine.process(&[0.125; 1024], &mut actual);
    reference.process(&effective, &mut expected);
    assert_eq!(actual, expected);
    for (actual, expected) in actual.iter().zip([
        0.0024475791628421123,
        0.009827865165731597,
        0.019723102086490633,
        0.02959520994218706,
    ]) {
        assert!((f64::from(*actual) - expected).abs() < 1e-7);
    }
    engine.record(0); // Finish overdub without any history-resetting action.
    assert_eq!(stored(&engine, 0, 1024), effective);
    engine.process(&[], &mut actual);
    reference.process(&effective, &mut expected);
    assert_eq!(actual, expected);
    assert!(actual[0] > 0.1); // Warm previous cycle, rather than a fresh impulse response.
}

fn two_playing() -> LoopEngine {
    let mut engine = LoopEngine::with_capacity(512);
    engine.record(0);
    engine.process(&[0.5; 16], &mut [0.0; 16]);
    engine.record(0);
    engine.record(1);
    engine.process(&[0.25; 16], &mut [0.0; 16]);
    engine.set_track_mute(0, true);
    engine.set_track_fx(0, filter(20.0)).unwrap();
    engine.set_track_fx(1, filter(20.0)).unwrap();
    engine.stop_transport();
    engine.play(0);
    engine.play(1);
    engine.process(&[], &mut [0.0; 10]);
    engine.set_track_fx(0, filter(1000.0)).unwrap();
    engine.set_track_fx(1, filter(1000.0)).unwrap();
    engine.process(&[], &mut [0.0; 10]);
    engine
}

#[test]
fn stop_clear_and_rerecord_leave_other_track_signal_and_ramp_untouched() {
    for clear in [false, true] {
        let mut local = two_playing();
        let mut reference = two_playing();
        if clear {
            local.clear(0);
        } else {
            local.stop_track(0);
        }
        let mut actual = [0.0; 128];
        let mut expected = [0.0; 128];
        local.process(&[], &mut actual);
        reference.process(&[], &mut expected);
        assert_eq!(actual, expected);
        assert!(actual[0] > 0.0);
        assert!(local.snapshot().fx[2].transitioning);
        if clear {
            local.record(0);
            local.process(&[0.0; 16], &mut [0.0; 16]);
            reference.process(&[], &mut [0.0; 16]);
            local.set_track_mute(0, false);
            local.process(&[], &mut actual);
            reference.process(&[], &mut expected);
            assert_eq!(actual, expected);
            assert_eq!(stored(&local, 0, 16), [0.0; 16]);
        }
    }
}
