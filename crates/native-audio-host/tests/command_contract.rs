use native_audio_host::{AudioCommand, CommandOutcome, HostEvent, Processor, RejectReason};

const SHARED_CONFORMANCE_CASES: &str =
    include_str!("../../../packages/domain/test-fixtures/audio-command-conformance.csv");

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
    processor.process_block(&[], &mut output, HostEvent::CaptureLost);
    assert_eq!(processor.session_generation(), stale.generation + 1);
    assert!(!processor.monitoring());
    assert_eq!(
        adapter.take_outcome().unwrap(),
        CommandOutcome::Stale {
            command_id: stale.command_id,
            generation: stale.generation,
        }
    );
    assert_eq!(adapter.flush(8), 0);
    assert_eq!(
        adapter.take_outcome().unwrap(),
        CommandOutcome::Stale {
            command_id: stale_staged.command_id,
            generation: stale_staged.generation,
        }
    );

    assert_eq!(
        adapter.submit(AudioCommand::SetMonitoring(true)),
        Err(RejectReason::Unavailable)
    );
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
