use loop_engine::{LoopEngine, PlaybackMode};

#[test]
fn first_loop_checkpoint_keeps_only_the_frozen_prefix() {
    let mut engine = LoopEngine::with_capacity(8);
    engine.record(0);
    engine.process(&[0.25, -0.5], &mut [0.0; 2]);
    let metadata = engine.begin_checkpoint().unwrap();
    assert_eq!(metadata.cycle_length, 2);
    assert_eq!(metadata.tracks[0].length, 2);
    engine.process(&[0.75, 1.0], &mut [0.0; 2]);
    let mut frozen = [0.0; 2];
    assert!(engine.read_checkpoint(0, 0, &mut frozen));
    assert_eq!(frozen, [0.25, -0.5]);
    assert_eq!(engine.snapshot().tracks[0].captured_samples, 4);
}

#[test]
fn overdub_checkpoint_survives_multiple_later_passes_and_chunk_reads() {
    let mut engine = LoopEngine::with_capacity(8);
    engine.record(0);
    engine.process(&[0.25, 0.5, 0.75], &mut [0.0; 3]);
    engine.record(0);
    engine.record(0);
    engine.process(&[1.0], &mut [0.0]);
    let metadata = engine.begin_checkpoint().unwrap();
    assert_eq!(metadata.tracks[0].length, 3);
    let mut first = [0.0];
    assert!(engine.read_checkpoint(0, 0, &mut first));
    engine.process(&[2.0; 8], &mut [0.0; 8]);
    let mut rest = [0.0; 2];
    assert!(engine.read_checkpoint(0, 1, &mut rest));
    assert_eq!(first, [1.25]);
    assert_eq!(rest, [0.5, 0.75]);
}

#[test]
fn one_shot_prefix_and_zero_capture_do_not_establish_a_cycle() {
    let mut engine = LoopEngine::with_capacity(8);
    engine.set_mode(0, PlaybackMode::OneShot);
    engine.record(0);
    assert_eq!(engine.begin_checkpoint().unwrap().tracks[0].length, 0);
    engine.cancel_checkpoint();
    engine.process(&[0.125, -0.25], &mut [0.0; 2]);
    let metadata = engine.begin_checkpoint().unwrap();
    assert_eq!(metadata.cycle_length, 0);
    assert_eq!(metadata.tracks[0].length, 2);
}

#[test]
fn joined_loop_freezes_wrapped_phase_and_uncaptured_silence() {
    let mut engine = LoopEngine::with_capacity(8);
    engine.record(0);
    engine.process(&[0.1; 4], &mut [0.0; 4]);
    engine.record(0);
    engine.process(&[0.0; 3], &mut [0.0; 3]);
    engine.record(1);
    engine.process(&[0.25, -0.5], &mut [0.0; 2]);
    assert_eq!(engine.begin_checkpoint().unwrap().tracks[1].length, 4);
    engine.process(&[0.75, 1.0], &mut [0.0; 2]);
    let mut frozen = [0.0; 4];
    assert!(engine.read_checkpoint(1, 0, &mut frozen));
    assert_eq!(frozen, [-0.5, 0.0, 0.0, 0.25]);
}

#[test]
fn cancelled_or_destructively_invalidated_checkpoints_fail_closed() {
    let mut engine = LoopEngine::with_capacity(4);
    engine.record(0);
    engine.process(&[0.25], &mut [0.0]);
    engine.begin_checkpoint().unwrap();
    engine.cancel_checkpoint();
    assert!(!engine.read_checkpoint(0, 0, &mut [0.0]));
    engine.begin_checkpoint().unwrap();
    engine.stop_transport();
    assert!(!engine.read_checkpoint(0, 0, &mut [0.0]));
    engine.record(0);
    engine.process(&[0.5], &mut [0.0]);
    engine.begin_checkpoint().unwrap();
    engine.clear(0);
    assert!(!engine.read_checkpoint(0, 0, &mut [0.0]));
}

#[test]
fn checkpoint_and_import_ownership_are_exclusive_and_reusable() {
    let mut engine = LoopEngine::with_capacity(4);
    let metadata = engine.begin_checkpoint().unwrap();
    assert!(engine.begin_checkpoint().is_none());
    assert!(!engine.begin_import(metadata, engine.command_revision()));
    engine.cancel_checkpoint();
    assert!(engine.begin_import(metadata, engine.command_revision()));
    assert!(engine.begin_checkpoint().is_none());
    engine.cancel_import();
    assert!(engine.begin_checkpoint().is_some());
}

#[test]
fn capacity_completion_does_not_invalidate_a_frozen_prefix() {
    let mut engine = LoopEngine::with_capacity(3);
    engine.record(0);
    engine.process(&[0.25, -0.5], &mut [0.0; 2]);
    engine.begin_checkpoint().unwrap();
    engine.process(&[0.75], &mut [0.0]);
    let mut frozen = [0.0; 2];
    assert!(engine.read_checkpoint(0, 0, &mut frozen));
    assert_eq!(frozen, [0.25, -0.5]);
    engine.cancel_checkpoint();
    assert_eq!(engine.begin_checkpoint().unwrap().tracks[0].length, 3);
    assert!(!engine.read_checkpoint(0, 0, &mut [0.0; 4]));
}

#[test]
fn nonfinite_audio_rejects_the_candidate() {
    let mut engine = LoopEngine::with_capacity(4);
    engine.record(0);
    let mut output = [1.0];
    engine.process(&[f32::INFINITY], &mut output);
    assert_eq!(output, [0.0]);
    assert!(engine.snapshot().audio_failed);
    assert_eq!(engine.snapshot().tracks[0].length_samples, 0);
    assert!(engine.begin_checkpoint().is_none());
    assert!(!engine.read_checkpoint(0, 0, &mut [0.0]));
    assert!(engine.checkpoint_metadata().is_none());
}

#[test]
fn independent_one_shot_cannot_establish_a_cycle_from_an_unplayed_converted_loop() {
    let mut engine = LoopEngine::with_capacity(8);
    engine.set_mode(0, PlaybackMode::OneShot);
    engine.record(0);
    engine.process(&[0.25, 0.5], &mut [0.0; 2]);
    engine.stop_track(0);
    engine.set_mode(0, PlaybackMode::Loop);
    engine.set_mode(1, PlaybackMode::OneShot);
    engine.record(1);
    engine.process(&[0.75], &mut [0.0]);
    assert_eq!(engine.snapshot().cycle_length_samples, 0);
    // No compatible recovery can include that retained Loop without changing cycle.
    assert!(engine.begin_checkpoint().is_none());
    assert_eq!(engine.snapshot().cycle_length_samples, 0);
}
