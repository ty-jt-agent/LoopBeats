use loop_engine::{FxConfig, TrackState};
use native_audio_host::{AudioCommand, CommandOutcome, HostEvent, Processor, RejectReason};

const SHARED_CONFORMANCE_CASES: &str =
    include_str!("../../../packages/domain/test-fixtures/audio-command-conformance.csv");

#[test]
fn applies_an_existing_effect_at_the_render_boundary_and_reports_its_state() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    let accepted = adapter
        .submit(AudioCommand::SetFx {
            scope: 0,
            config: FxConfig::LowPass {
                cutoff_hz: 2_000.0,
                bypassed: false,
            },
        })
        .unwrap();
    assert_eq!(adapter.flush(1), 1);

    let mut output = [0.0; 4];
    processor.process_block(&[0.25; 4], &mut output, HostEvent::None);

    assert_eq!(
        processor.snapshot().fx[0].config,
        FxConfig::LowPass {
            cutoff_hz: 2_000.0,
            bypassed: false,
        }
    );
    assert_eq!(
        adapter.take_outcome(),
        Some(CommandOutcome::Applied {
            command_id: accepted.command_id,
            generation: accepted.generation,
            application_frame: 0,
            block_sequence: 1,
        })
    );
}

#[test]
fn retained_recording_survives_device_failure_export_and_host_restore_exactly() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    let record = adapter.submit(AudioCommand::Record(0)).unwrap();
    adapter.flush(1);
    let mut output = [0.0; 4];
    processor.process_block(&[0.125, -0.25, 0.5, -0.75], &mut output, HostEvent::None);
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        record.command_id
    );

    let finish = adapter.submit(AudioCommand::Record(0)).unwrap();
    adapter.flush(1);
    processor.process_block(&[0.0; 4], &mut output, HostEvent::None);
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        finish.command_id
    );

    let overdub = adapter.submit(AudioCommand::Record(0)).unwrap();
    adapter.flush(1);
    processor.process_block(&[0.01, -0.02, 0.03, -0.04], &mut output, HostEvent::None);
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        overdub.command_id
    );
    processor.process_block(&[], &mut [], HostEvent::DeviceFailed);

    let retained = processor.export_retained_session().unwrap();
    assert_eq!(retained.tracks[0], [0.135, -0.27, 0.53, -0.79]);
    assert_eq!(retained.metadata.cycle_length, 4);
    let (mut recovered_adapter, mut recovered) =
        Processor::controlled_with_session(16, 48_000, Some(&retained)).unwrap();
    assert_eq!(recovered.snapshot().tracks[0].state, TrackState::Stopped);

    let play = recovered_adapter.submit(AudioCommand::Play(0)).unwrap();
    recovered_adapter.flush(1);
    recovered.process_block(&[0.0; 4], &mut output, HostEvent::None);

    assert_eq!(
        recovered_adapter.take_outcome().unwrap().command_id(),
        play.command_id
    );
    assert_eq!(output, [0.135, -0.27, 0.53, -0.79]);
}

#[test]
fn published_snapshots_show_applied_state_and_confirmed_capture_interruption() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    let snapshots = processor.snapshot_feed();
    let monitoring = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    let record = adapter.submit(AudioCommand::Record(0)).unwrap();
    assert_eq!(adapter.flush(2), 2);

    let mut output = [0.0; 4];
    processor.process_block(&[0.25; 4], &mut output, HostEvent::None);
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        monitoring.command_id
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        record.command_id
    );
    let applied = snapshots.pop().unwrap();
    assert!(applied.monitoring);
    assert_eq!(applied.tracks[0].state, TrackState::Recording);

    processor.process_block(&[0.5; 4], &mut output, HostEvent::CaptureLost);
    let interrupted = snapshots.pop().unwrap();
    assert!(!interrupted.monitoring);
    assert_eq!(interrupted.tracks[0].state, TrackState::Empty);
    assert!(!interrupted.transport_running);
    assert_eq!(interrupted.transport_position_samples, 0);
}

#[test]
fn commands_published_before_a_block_apply_fifo_with_actual_block_position() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    let rows = shared_case("fifo");
    let accepted = rows
        .iter()
        .map(|row| adapter.submit(command_from_shared_case(row)).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(adapter.flush(8), rows.len());

    let mut output = [0.0; 4];
    processor.process_block(&[0.0; 4], &mut output, HostEvent::None);

    assert_eq!(processor.block_sequence(), 1);
    assert_eq!(processor.rendered_frames(), 4);
    assert_eq!(processor.snapshot().master_gain, 0.5);
    assert!(processor.monitoring());
    for (row, accepted) in rows.iter().zip(accepted) {
        assert_eq!(
            adapter.take_outcome(),
            Some(CommandOutcome::Applied {
                command_id: accepted.command_id,
                generation: accepted.generation,
                application_frame: row[4].parse().unwrap(),
                block_sequence: row[5].parse().unwrap(),
            })
        );
    }
}

#[test]
fn command_from_an_old_generation_is_rejected_before_native_admission() {
    let (mut adapter, mut processor) = Processor::controlled(32, 48_000);
    let old_generation = adapter.session_generation();
    adapter.restart();
    let current_generation = adapter.session_generation();

    assert_eq!(
        adapter.submit_for_generation(AudioCommand::SetMonitoring(true), old_generation),
        Err(RejectReason::StaleGeneration)
    );
    let accepted = adapter
        .submit_for_generation(AudioCommand::SetMonitoring(true), current_generation)
        .unwrap();
    adapter.flush(8);
    let mut output = [0.0; 1];
    processor.process_block(&[], &mut output, HostEvent::None);
    assert!(processor.snapshot().monitoring);
    assert!(matches!(
        adapter.take_outcome(),
        Some(CommandOutcome::Applied { command_id, generation, .. })
            if command_id == accepted.command_id && generation == current_generation
    ));
}

#[test]
fn outstanding_command_is_settled_when_stop_follows_persistent_capture_loss() {
    let (mut adapter, mut processor) = Processor::controlled(32, 48_000);
    let accepted = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    adapter.flush(8);
    let mut output = [0.0; 1];

    for _ in 0..4 {
        processor.process_block(&[0.0], &mut output, HostEvent::CaptureLost);
        assert_eq!(adapter.take_outcome(), None);
    }

    adapter.shutdown();
    processor.settle_pending_after_failure();
    assert_eq!(
        adapter.take_outcome(),
        Some(CommandOutcome::Stale {
            command_id: accepted.command_id,
            generation: accepted.generation,
        })
    );
}

fn shared_case(name: &str) -> Vec<Vec<&'static str>> {
    SHARED_CONFORMANCE_CASES
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
        .map(|line| line.split(';').collect::<Vec<_>>())
        .filter(|fields| fields[0] == name)
        .collect()
}

fn command_from_shared_case(row: &[&str]) -> AudioCommand {
    match (row[2], row[3]) {
        ("set-master-gain", gain) => AudioCommand::SetMasterGain(gain.parse().unwrap()),
        ("monitoring", enabled) => AudioCommand::SetMonitoring(enabled.parse().unwrap()),
        other => panic!("unsupported shared test command: {other:?}"),
    }
}

#[test]
fn shared_backpressure_case_rejects_before_acceptance_without_stalling_processing() {
    let fields = SHARED_CONFORMANCE_CASES
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
        .map(|line| line.split(';').collect::<Vec<_>>())
        .find(|fields| fields[0] == "backpressure")
        .unwrap();
    let ack_capacity: usize = fields[1].parse().unwrap();
    let accepted_count: usize = fields[2].parse().unwrap();
    let processing_blocks: usize = fields[3].parse().unwrap();
    let work_budget: usize = fields[4].parse().unwrap();
    let frames_per_block: usize = fields[5].parse().unwrap();
    let (mut adapter, mut processor) =
        Processor::controlled_with_limits(16, 48_000, accepted_count, ack_capacity, work_budget);
    let accepted = (0..accepted_count)
        .map(|_| adapter.submit(AudioCommand::StopTransport).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        adapter.submit(AudioCommand::StopTransport),
        Err(RejectReason::Overloaded)
    );
    assert_eq!(adapter.flush(accepted_count), accepted_count);

    let mut output = [0.0; 4];
    for _ in 0..processing_blocks {
        processor.process_block(&[], &mut output[..frames_per_block], HostEvent::None);
    }
    assert_eq!(processor.block_sequence(), processing_blocks as u64);
    assert_eq!(
        adapter.submit(AudioCommand::StopTransport),
        Err(RejectReason::Overloaded)
    );

    for (index, accepted) in accepted.into_iter().enumerate() {
        let block_offset = index / work_budget;
        assert_eq!(
            adapter.take_outcome().unwrap(),
            CommandOutcome::Applied {
                command_id: accepted.command_id,
                generation: accepted.generation,
                application_frame: (block_offset * frames_per_block) as u64,
                block_sequence: block_offset as u64 + 1,
            }
        );
    }
}

#[test]
fn start_tracks_respects_the_shared_active_track_guard() {
    for row in shared_case("start-tracks") {
        let (mut adapter, mut processor) = Processor::controlled(32, 48_000);
        match row[1] {
            "active-one-shot" => {
                create_stopped_one_shot(&mut adapter, &mut processor, 0);
                create_stopped_one_shot(&mut adapter, &mut processor, 1);
                submit_block(&mut adapter, &mut processor, AudioCommand::Play(1), &[], 1);
            }
            "active-recording" => {
                create_stopped_one_shot(&mut adapter, &mut processor, 1);
                submit_block(
                    &mut adapter,
                    &mut processor,
                    AudioCommand::Record(0),
                    &[0.25],
                    1,
                );
            }
            "all-stopped" => {
                create_stopped_one_shot(&mut adapter, &mut processor, 0);
                create_stopped_one_shot(&mut adapter, &mut processor, 1);
            }
            other => panic!("unsupported shared start-tracks case: {other}"),
        }

        let before = processor.snapshot();
        for (track_id, expected_state) in row[2].split(',').enumerate() {
            assert_eq!(
                before.tracks[track_id].state as u32,
                expected_state.parse::<u32>().unwrap(),
                "fixture precondition for {} track {track_id}",
                row[1]
            );
        }
        let accepted = adapter
            .submit(AudioCommand::StartTracks)
            .expect("start command is admitted");
        adapter.flush(1);
        let mut output = [0.0; 1];
        processor.process_block(&[], &mut output, HostEvent::None);
        let after = processor.snapshot();
        let expected_plays = row[3]
            .split(',')
            .filter(|value| !value.is_empty())
            .map(|value| value.parse::<usize>().unwrap())
            .collect::<Vec<_>>();

        for track_id in 0..2 {
            if expected_plays.contains(&track_id) {
                assert_eq!(
                    after.tracks[track_id].state,
                    loop_engine::TrackState::Playing
                );
            } else {
                assert_eq!(after.tracks[track_id].state, before.tracks[track_id].state);
            }
        }
        if row[1] == "active-one-shot" {
            assert_eq!(
                after.tracks[1].position_samples,
                before.tracks[1].position_samples + 1
            );
        }
        assert_eq!(
            adapter.take_outcome().unwrap(),
            CommandOutcome::Applied {
                command_id: accepted.command_id,
                generation: accepted.generation,
                application_frame: processor.rendered_frames() - 1,
                block_sequence: processor.block_sequence(),
            }
        );
    }
}

fn create_stopped_one_shot(
    adapter: &mut native_audio_host::CommandAdapter,
    processor: &mut Processor,
    track_id: usize,
) {
    submit_block(
        adapter,
        processor,
        AudioCommand::SetMode {
            track_id,
            mode: loop_engine::PlaybackMode::OneShot,
        },
        &[],
        1,
    );
    submit_block(
        adapter,
        processor,
        AudioCommand::Record(track_id),
        &[0.25, 0.5, 0.75],
        3,
    );
    submit_block(adapter, processor, AudioCommand::Record(track_id), &[], 1);
    submit_block(
        adapter,
        processor,
        AudioCommand::StopTrack(track_id),
        &[],
        1,
    );
}

fn submit_block(
    adapter: &mut native_audio_host::CommandAdapter,
    processor: &mut Processor,
    command: AudioCommand,
    input: &[f32],
    output_frames: usize,
) {
    adapter.submit(command).expect("setup command is admitted");
    assert_eq!(adapter.flush(1), 1);
    let mut output = [0.0; 4];
    processor.process_block(input, &mut output[..output_frames], HostEvent::None);
    adapter
        .take_outcome()
        .expect("setup command has an outcome");
}

#[test]
fn per_block_work_is_bounded_and_remaining_commands_keep_fifo_order() {
    let (mut adapter, mut processor) = Processor::controlled_with_limits(16, 48_000, 8, 8, 2);
    let first = adapter.submit(AudioCommand::SetMasterGain(0.2)).unwrap();
    let second = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    let third = adapter.submit(AudioCommand::SetMasterGain(0.6)).unwrap();
    adapter.flush(8);
    let mut output = [0.0; 1];
    processor.process_block(&[], &mut output, HostEvent::None);
    assert_eq!(processor.snapshot().master_gain, 0.2);
    processor.process_block(&[], &mut output, HostEvent::None);
    assert_eq!(processor.snapshot().master_gain, 0.6);
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        first.command_id
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        second.command_id
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        third.command_id
    );
}

#[test]
fn consecutive_staged_gain_assignments_supersede_but_barriers_end_coalescing() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    let first = adapter
        .submit(AudioCommand::SetTrackGain {
            track_id: 0,
            gain: 0.2,
        })
        .unwrap();
    let replacement = adapter
        .submit(AudioCommand::SetTrackGain {
            track_id: 0,
            gain: 0.8,
        })
        .unwrap();
    let barrier = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    let after_barrier = adapter
        .submit(AudioCommand::SetTrackGain {
            track_id: 0,
            gain: 0.4,
        })
        .unwrap();
    assert_eq!(
        adapter.take_outcome(),
        Some(CommandOutcome::Superseded {
            command_id: first.command_id,
            generation: first.generation,
            replacement_command_id: replacement.command_id,
        })
    );
    adapter.flush(8);
    let mut output = [0.0; 1];
    processor.process_block(&[], &mut output, HostEvent::None);
    assert_eq!(processor.snapshot().tracks[0].gain, 0.4);
    assert!(processor.monitoring());
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        replacement.command_id
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        barrier.command_id
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        after_barrier.command_id
    );
}

#[test]
fn admission_reserves_terminal_capacity_and_stalled_consumer_never_blocks_processing() {
    let (mut adapter, mut processor) = Processor::controlled_with_limits(16, 48_000, 8, 2, 8);
    let accepted =
        [0.2, 0.3].map(|gain| adapter.submit(AudioCommand::SetMasterGain(gain)).unwrap());
    assert!(adapter.submit(AudioCommand::SetMonitoring(true)).is_err());
    adapter.flush(8);
    let mut output = [0.0; 1];
    processor.process_block(&[], &mut output, HostEvent::None);
    assert_eq!(processor.snapshot().master_gain, 0.3);
    assert!(adapter.submit(AudioCommand::SetMonitoring(true)).is_err());
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        accepted[0].command_id
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        accepted[1].command_id
    );
    assert!(adapter.submit(AudioCommand::SetMonitoring(true)).is_ok());
}

#[test]
fn a_gain_assignment_is_immutable_after_handoff_and_applies_without_a_ramp() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    let handed_off = adapter.submit(AudioCommand::SetMasterGain(0.5)).unwrap();
    assert_eq!(adapter.flush(8), 2);

    let input = [0.8; 4];
    let mut output = [0.0; 4];
    processor.process_block(&input, &mut output, HostEvent::None);
    assert_eq!(output, [0.4; 4]);
    let later = adapter.submit(AudioCommand::SetMasterGain(0.25)).unwrap();
    adapter.flush(8);
    processor.process_block(&input, &mut output, HostEvent::None);
    assert_eq!(output, [0.2; 4]);
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        handed_off.command_id - 1
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        handed_off.command_id
    );
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        later.command_id
    );
}

#[test]
fn host_fault_invalidates_old_generation_before_applying_ui_commands() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    let stale = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    let stale_staged = adapter.submit(AudioCommand::SetMasterGain(0.25)).unwrap();
    adapter.flush(1);
    let mut output = [0.0; 1];
    processor.process_block(&[], &mut output, HostEvent::DeviceFailed);
    assert_eq!(processor.session_generation(), stale.generation + 1);
    assert!(!processor.monitoring());
    assert_eq!(
        adapter.take_outcome().unwrap(),
        CommandOutcome::Stale {
            command_id: stale.command_id,
            generation: stale.generation,
        }
    );
    assert_eq!(
        adapter.take_outcome().unwrap(),
        CommandOutcome::Stale {
            command_id: stale_staged.command_id,
            generation: stale_staged.generation,
        }
    );
    assert_eq!(adapter.flush(8), 0);

    assert_eq!(
        adapter.submit(AudioCommand::SetMonitoring(true)),
        Err(RejectReason::Unavailable)
    );
    processor.settle_pending_after_failure();
    adapter.restart();
    let current = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    adapter.flush(8);
    processor.process_block(&[], &mut output, HostEvent::None);
    assert!(processor.monitoring());
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        current.command_id
    );
}

#[test]
fn shutdown_then_restart_without_a_render_block_still_interrupts_the_session() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    adapter.submit(AudioCommand::Record(0)).unwrap();
    adapter.flush(8);
    let mut output = [0.0; 1];
    processor.process_block(&[0.5], &mut output, HostEvent::None);
    assert_eq!(
        processor.snapshot().tracks[0].state,
        loop_engine::TrackState::Recording
    );
    assert!(processor.monitoring());

    adapter.shutdown();
    adapter.restart();
    processor.process_block(&[0.75], &mut output, HostEvent::None);

    assert_eq!(
        processor.snapshot().tracks[0].state,
        loop_engine::TrackState::Empty
    );
    assert_eq!(processor.snapshot().tracks[0].captured_samples, 0);
    assert!(!processor.monitoring());
    assert_eq!(output, [0.0]);
}

#[test]
fn playback_only_capture_loss_keeps_transport_running_and_reports_the_gap() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    submit_block(
        &mut adapter,
        &mut processor,
        AudioCommand::Record(0),
        &[0.2, 0.4],
        2,
    );
    submit_block(
        &mut adapter,
        &mut processor,
        AudioCommand::Record(0),
        &[],
        1,
    );
    let generation = processor.session_generation();
    let mut output = [0.0; 1];
    processor.process_block(&[], &mut output, HostEvent::CaptureLost);

    assert_eq!(output, [0.4]);
    assert_eq!(
        processor.snapshot().tracks[0].state,
        loop_engine::TrackState::Playing
    );
    assert!(processor.snapshot().transport_running);
    assert_eq!(processor.session_generation(), generation);
    assert_eq!(processor.capture_discontinuities(), 1);
}

#[test]
fn capture_loss_during_recording_interrupts_before_the_next_capture_block() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    submit_block(
        &mut adapter,
        &mut processor,
        AudioCommand::Record(0),
        &[0.2],
        1,
    );
    let pending_ui_command = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    adapter.flush(1);
    let generation = processor.session_generation();
    let mut output = [1.0; 1];
    processor.process_block(&[0.8], &mut output, HostEvent::CaptureLost);

    assert_eq!(
        processor.snapshot().tracks[0].state,
        loop_engine::TrackState::Empty
    );
    assert_eq!(processor.snapshot().tracks[0].captured_samples, 0);
    assert!(!processor.monitoring());
    assert_eq!(processor.session_generation(), generation + 1);
    assert_eq!(processor.capture_discontinuities(), 1);
    assert_eq!(output, [0.0]);
    processor.process_block(&[], &mut output, HostEvent::None);
    assert!(!processor.monitoring());
    assert_eq!(
        adapter.take_outcome(),
        Some(CommandOutcome::Stale {
            command_id: pending_ui_command.command_id,
            generation: pending_ui_command.generation,
        })
    );
}

#[test]
fn capture_loss_during_overdub_keeps_only_additions_written_before_the_gap() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    submit_block(
        &mut adapter,
        &mut processor,
        AudioCommand::Record(0),
        &[0.25, 0.5],
        2,
    );
    submit_block(
        &mut adapter,
        &mut processor,
        AudioCommand::Record(0),
        &[],
        1,
    );
    submit_block(
        &mut adapter,
        &mut processor,
        AudioCommand::Record(0),
        &[0.25],
        1,
    );
    assert_eq!(
        processor.snapshot().tracks[0].state,
        loop_engine::TrackState::Overdubbing
    );

    let generation = processor.session_generation();
    let mut output = [0.0; 1];
    processor.process_block(&[0.9], &mut output, HostEvent::CaptureLost);
    assert_eq!(
        processor.snapshot().tracks[0].state,
        loop_engine::TrackState::Stopped
    );
    assert_eq!(processor.session_generation(), generation + 1);

    let replay = adapter.submit(AudioCommand::Play(0)).unwrap();
    adapter.flush(1);
    let mut replay_output = [0.0; 2];
    processor.process_block(&[], &mut replay_output, HostEvent::None);
    assert_eq!(replay_output, [0.25, 0.75]);
    assert_eq!(
        adapter.take_outcome().unwrap().command_id(),
        replay.command_id
    );
}

#[test]
fn shutdown_silences_the_controlled_host_until_explicit_restart() {
    let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
    adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    adapter.flush(8);
    let mut output = [1.0; 4];
    processor.process_block(&[0.5; 4], &mut output, HostEvent::None);
    assert_eq!(output, [0.5; 4]);
    adapter.take_outcome();
    adapter.shutdown();
    processor.process_block(&[0.5; 4], &mut output, HostEvent::None);
    assert_eq!(output, [0.0; 4]);
    adapter.restart();
    adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    adapter.flush(8);
    processor.process_block(&[0.5; 4], &mut output, HostEvent::None);
    assert_eq!(output, [0.5; 4]);
}
