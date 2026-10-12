use loop_engine::{FxConfig, FxError, LoopEngine};

#[test]
fn input_filter_is_baked_once_and_bypass_only_changes_future_capture() {
    let mut engine = LoopEngine::with_capacity(2048);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false,
        })
        .unwrap();
    engine.stop_transport(); // Fresh history and accepted targets, without a startup ramp.
    engine.set_monitoring(true);
    engine.record(0);
    let mut monitored = [0.0; 4];
    engine.process(&[0.5, 0.0, 0.0, 0.0], &mut monitored);
    // Independent cookbook response at 48 kHz, 1 kHz, Q=1/sqrt(2).
    for (actual, expected) in
        monitored
            .iter()
            .zip([0.0019580633_f64, 0.0074706795, 0.0138927331, 0.0190118728])
    {
        assert!((f64::from(*actual) - expected).abs() < 0.00000001);
    }
    engine.record(0);
    engine.set_input_fx(FxConfig::None).unwrap();
    engine.stop_transport();
    engine.set_monitoring(false);
    engine.play(0);
    let mut dry_playback = [0.0; 4];
    engine.process(&[], &mut dry_playback);
    assert_eq!(dry_playback, monitored);
    engine.record(0); // Overdub, only new dry input is added.
    engine.process(&[0.125; 4], &mut dry_playback);
    for (actual, recorded) in dry_playback.iter().zip(monitored) {
        assert_eq!(*actual, recorded + 0.125);
    }
    assert_eq!(engine.snapshot().fx[0].config, FxConfig::None);
    assert_eq!(
        engine.set_input_fx(FxConfig::LowPass {
            cutoff_hz: f64::NAN,
            bypassed: true
        }),
        Err(FxError::Invalid)
    );
}

#[test]
fn changing_cutoff_does_not_restart_an_ongoing_bypass_ramp() {
    let mut engine = LoopEngine::with_capacity(1024);
    engine.set_monitoring(true);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: true,
        })
        .unwrap();
    engine.stop_transport();
    engine.process(&[0.25; 4096], &mut [0.0; 4096]);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false,
        })
        .unwrap();
    engine.process(&[0.25; 240], &mut [0.0; 240]);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 2000.0,
            bypassed: false,
        })
        .unwrap();
    engine.process(&[0.25; 240], &mut [0.0; 240]);
    // Compare the exact next sample to an always-wet reference with matching history.
    let mut reference = LoopEngine::with_capacity(1024);
    reference
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false,
        })
        .unwrap();
    reference.stop_transport();
    reference.set_monitoring(true);
    reference.process(&[0.25; 4096], &mut [0.0; 4096]);
    reference.process(&[0.25; 240], &mut [0.0; 240]);
    reference
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 2000.0,
            bypassed: false,
        })
        .unwrap();
    reference.process(&[0.25; 240], &mut [0.0; 240]);
    let mut actual = [0.0];
    engine.process(&[0.5], &mut actual);
    let mut expected = [0.0];
    reference.process(&[0.5], &mut expected);
    assert!((actual[0] - expected[0]).abs() < 0.000001);
}

#[test]
fn numerical_response_is_correct_at_every_supported_rate_and_bound() {
    for rate in [8000, 44100, 48000, 192000] {
        let maximum = 20_000.0_f64.min(f64::from(rate) * 0.45);
        for cutoff in [20.0, 1000.0, maximum] {
            let mut engine = LoopEngine::with_capacity_and_sample_rate(8, rate);
            assert!(engine.snapshot().fx.iter().all(|slot| slot.config
                == FxConfig::LowPass {
                    cutoff_hz: maximum,
                    bypassed: true
                }));
            engine
                .set_input_fx(FxConfig::LowPass {
                    cutoff_hz: cutoff,
                    bypassed: false,
                })
                .unwrap();
            engine.stop_transport();
            engine.set_monitoring(true);
            let settling = (f64::from(rate) * 0.5) as usize;
            let samples = (f64::from(rate) * 2.0) as usize;
            let input: Vec<_> = (0..samples)
                .map(|i| {
                    (std::f64::consts::TAU * cutoff * i as f64 / f64::from(rate)).sin() as f32
                        * 0.25
                })
                .collect();
            let mut output = vec![0.0; samples];
            engine.process(&input, &mut output);
            let power_in: f64 = input[settling..]
                .iter()
                .map(|x| f64::from(*x).powi(2))
                .sum();
            let power_out: f64 = output[settling..]
                .iter()
                .map(|x| f64::from(*x).powi(2))
                .sum();
            let db = 10.0 * (power_out / power_in).log10();
            assert!(
                (db + 3.0103).abs() < 0.1,
                "rate={rate} cutoff={cutoff} dB={db}"
            );
            engine.process(&vec![0.25; settling], &mut vec![0.0; settling]);
            let mut dc = [0.0; 1];
            engine.process(&[0.25], &mut dc);
            assert!((dc[0] - 0.25).abs() < 0.002);
        }
    }
}

#[test]
fn removal_is_acknowledged_before_its_exact_bounded_retirement() {
    let mut engine = LoopEngine::with_capacity_and_sample_rate(8, 44100);
    engine.set_input_fx(FxConfig::None).unwrap();
    assert_eq!(engine.snapshot().fx[0].config, FxConfig::None);
    assert!(engine.snapshot().fx[0].removing);
    assert_eq!(engine.set_input_fx(FxConfig::None), Err(FxError::Busy));
    engine.process(&[], &mut [0.0; 440]);
    assert!(engine.snapshot().fx[0].removing);
    engine.process(&[], &mut [0.0]);
    assert!(!engine.snapshot().fx[0].removing);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 19845.0,
            bypassed: true,
        })
        .unwrap();
    engine.set_input_fx(FxConfig::None).unwrap();
    engine.interrupt();
    assert!(!engine.snapshot().fx[0].removing);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 19845.0,
            bypassed: true,
        })
        .unwrap();
    engine.process(&[], &mut [0.0; 441]);
    assert_ne!(engine.snapshot().fx[0].config, FxConfig::None);
}

#[test]
fn warm_bypass_and_lifecycle_clears_keep_configuration_but_not_old_history() {
    let mut engine = LoopEngine::with_capacity(2048);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: true,
        })
        .unwrap();
    engine.stop_transport();
    engine.set_monitoring(true);
    let mut dry = [0.0; 1024];
    engine.process(&[0.25; 1024], &mut dry);
    assert_eq!(dry, [0.25; 1024]);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false,
        })
        .unwrap();
    let mut warm = [0.0];
    engine.process(&[0.25], &mut warm);
    assert_eq!(warm, [0.25]);
    engine.stop_transport();
    assert!(!engine.snapshot().fx[0].transitioning);
    engine.process(&[0.0], &mut warm);
    assert_eq!(warm, [0.0]);
    assert!(engine.monitoring()); // Global STOP retains explicitly enabled monitoring.
    engine.interrupt();
    assert!(!engine.monitoring());
    assert_eq!(
        engine.snapshot().fx[0].config,
        FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false
        }
    );
    engine.reset();
    assert_eq!(
        engine.snapshot().fx[0].config,
        FxConfig::LowPass {
            cutoff_hz: 20000.0,
            bypassed: true
        }
    );
}

#[test]
fn invalid_commands_leave_configuration_and_revision_unchanged_and_nonfinite_audio_fails_closed() {
    let mut engine = LoopEngine::with_capacity(8);
    let before = engine.snapshot().fx;
    let revision = engine.command_revision();
    for invalid in [f64::NAN, f64::INFINITY, -1.0, 19.0, 20001.0] {
        assert_eq!(
            engine.set_input_fx(FxConfig::LowPass {
                cutoff_hz: invalid,
                bypassed: true
            }),
            Err(FxError::Invalid)
        );
    }
    assert_eq!(engine.snapshot().fx, before);
    assert_eq!(engine.command_revision(), revision);
    engine.record(0);
    engine.set_monitoring(true);
    let mut output = [1.0; 3];
    engine.process(&[0.25, f32::NAN, 0.5], &mut output);
    assert_eq!(output, [0.0; 3]);
    assert!(engine.snapshot().audio_failed);
    assert!(!engine.monitoring());
    assert_eq!(engine.snapshot().tracks[0].length_samples, 0);
    assert_eq!(
        engine.set_input_fx(FxConfig::None),
        Err(FxError::Unavailable)
    );
}

#[test]
fn exact_ramps_and_rapid_retargeting_do_not_depend_on_block_boundaries() {
    fn render(block: usize) -> (Vec<f32>, u64) {
        let mut engine = LoopEngine::with_capacity(2048);
        engine.set_monitoring(true);
        engine.record(0);
        let mut result = Vec::new();
        for (cutoff, bypassed) in [
            (20.0, false),
            (20000.0, true),
            (1000.0, false),
            (3000.0, false),
        ] {
            engine
                .set_input_fx(FxConfig::LowPass {
                    cutoff_hz: cutoff,
                    bypassed,
                })
                .unwrap();
            let input: Vec<_> = (0..480)
                .map(|i| if i % 13 == 0 { 0.5 } else { -0.125 })
                .collect();
            for chunk in input.chunks(block) {
                let mut output = vec![0.0; chunk.len()];
                engine.process(chunk, &mut output);
                result.extend(output);
            }
            assert!(!engine.snapshot().fx[0].transitioning);
        }
        engine.record(0);
        engine.process(&[], &mut [0.0; 7]);
        (result, engine.snapshot().transport_position_samples)
    }
    let reference = render(480);
    for block in [1, 3, 128, 257] {
        assert_eq!(render(block), reference);
    }

    let mut engine = LoopEngine::with_capacity(1024);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false,
        })
        .unwrap();
    engine.process(&[], &mut [0.0; 479]);
    assert!(engine.snapshot().fx[0].transitioning);
    engine.process(&[], &mut [0.0]);
    assert!(!engine.snapshot().fx[0].transitioning);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 3000.0,
            bypassed: true,
        })
        .unwrap();
    engine.process(&[], &mut [0.0; 240]);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 20.0,
            bypassed: false,
        })
        .unwrap();
    engine.process(&[], &mut [0.0; 480]);
    assert!(!engine.snapshot().fx[0].transitioning);
    assert_eq!(
        engine.snapshot().fx[0].config,
        FxConfig::LowPass {
            cutoff_hz: 20.0,
            bypassed: false
        }
    );
}

#[test]
fn rapid_extreme_edits_and_overrange_capture_are_finite_without_capture_clamping() {
    for rate in [8000, 44100, 48000, 192000] {
        let mut engine = LoopEngine::with_capacity_and_sample_rate(8192, rate);
        engine.set_monitoring(true);
        engine.record(0);
        for index in 0..64 {
            engine
                .set_input_fx(FxConfig::LowPass {
                    cutoff_hz: if index % 2 == 0 {
                        20.0
                    } else {
                        20_000.0_f64.min(f64::from(rate) * 0.45)
                    },
                    bypassed: index % 3 == 0,
                })
                .unwrap();
            let mut output = [0.0; 64];
            engine.process(&[2.0; 64], &mut output);
            assert!(output.iter().all(|s| s.is_finite()));
            assert!(!engine.snapshot().audio_failed);
        }
        engine.stop_track(0);
        let revision = engine.recording_revision(0);
        let mut recorded = [0.0; 64];
        assert!(engine.read_recording(0, revision, 0, &mut recorded));
        assert!(recorded.iter().any(|s| *s > 1.0));
        engine.process(&[], &mut [0.0; 4096]);
        let mut silent = [1.0; 8];
        engine.stop_transport();
        engine.process(&[], &mut silent);
        assert_eq!(silent, [0.0; 8]);
    }
}

#[test]
fn finite_overrange_playback_plus_monitoring_is_silent_at_master_zero() {
    let mut engine = LoopEngine::with_capacity(8);
    engine.record(0);
    engine.process(&[f32::MAX; 2], &mut [0.0; 2]);
    engine.record(0);
    engine.set_monitoring(true);
    engine.set_master_gain(0.0);
    let mut output = [1.0; 2];
    engine.process(&[f32::MAX; 2], &mut output);
    assert_eq!(output, [0.0; 2]);
    assert!(!engine.snapshot().audio_failed);
    engine.set_master_gain(1.0);
    engine.process(&[f32::MAX; 2], &mut output);
    assert_eq!(output, [1.0; 2]);
    let mut recorded = [0.0; 2];
    assert!(engine.read_recording(0, engine.recording_revision(0), 0, &mut recorded));
    assert_eq!(recorded, [f32::MAX; 2]);
}

#[test]
fn repeated_overdub_bakes_exactly_one_filtered_addition_and_never_filters_the_retained_base() {
    let mut engine = LoopEngine::with_capacity(2048);
    engine.record(0);
    engine.process(&[0.125; 1024], &mut [0.0; 1024]);
    engine.record(0);
    engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false,
        })
        .unwrap();
    engine.stop_transport();
    engine.play(0);
    let mut input = [0.0; 1024];
    input[0] = 0.5;
    // Independent transfer-function impulse fixtures, not another engine output.
    let impulse = [
        0.00195806333027369,
        0.00747067946653054,
        0.01389273310983166,
        0.01901187277242247,
    ];
    for cycle in 1..=3 {
        engine.record(0);
        engine.process(&input, &mut [0.0; 1024]);
        engine.record(0);
        let mut recorded = [0.0; 4];
        assert!(engine.read_recording(0, engine.recording_revision(0), 0, &mut recorded));
        for (actual, addition) in recorded.into_iter().zip(impulse) {
            assert!((f64::from(actual) - (0.125 + f64::from(cycle) * addition)).abs() < 0.0000001);
        }
    }
    assert_eq!(engine.snapshot().transport_position_samples, 3072);
    assert_eq!(engine.snapshot().tracks[0].length_samples, 1024);
}
