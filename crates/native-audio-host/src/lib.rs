//! Controlled native command scheduler around the portable `LoopEngine`.
//!
//! The adapter owns bounded staging and UI lifecycle. `Processor` owns the engine
//! and is the only type that mutates it while rendering. The queues are allocated
//! at construction; render-block work uses bounded, allocation-free operations.
use crossbeam_queue::ArrayQueue;
use loop_engine::{EngineSnapshot, LoopEngine, PlaybackMode, TrackState};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

pub const DEFAULT_COMMAND_CAPACITY: usize = 64;
pub const DEFAULT_ACK_CAPACITY: usize = 128;
pub const DEFAULT_BLOCK_BUDGET: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AudioCommand {
    SetTrackGain { track_id: usize, gain: f32 },
    SetTrackMute { track_id: usize, muted: bool },
    SetMasterGain(f32),
    SetMonitoring(bool),
    SetMode { track_id: usize, mode: PlaybackMode },
    Record(usize),
    Play(usize),
    StopTrack(usize),
    StopTransport,
    StartTracks,
    Clear(usize),
    Reset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AcceptedCommand {
    pub command_id: u64,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    Unavailable,
    Overloaded,
    InvalidCommand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandOutcome {
    Applied {
        command_id: u64,
        generation: u64,
        application_frame: u64,
        block_sequence: u64,
    },
    Superseded {
        command_id: u64,
        generation: u64,
        replacement_command_id: u64,
    },
    Stale {
        command_id: u64,
        generation: u64,
    },
}

impl CommandOutcome {
    pub fn command_id(self) -> u64 {
        match self {
            Self::Applied { command_id, .. }
            | Self::Superseded { command_id, .. }
            | Self::Stale { command_id, .. } => command_id,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostEvent {
    None,
    CaptureLost,
    DeviceFailed,
}

#[derive(Clone, Copy)]
struct Envelope {
    accepted: AcceptedCommand,
    command: AudioCommand,
}

struct SharedQueues {
    audio: Arc<ArrayQueue<Envelope>>,
    outcomes: Arc<ArrayQueue<CommandOutcome>>,
    outstanding: Arc<AtomicUsize>,
    generation: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
    next_command_id: AtomicU64,
    ack_capacity: usize,
}

/// UI-side command admission, staging, coalescing and lifecycle control.
pub struct CommandAdapter {
    shared: Arc<SharedQueues>,
    staging: VecDeque<Envelope>,
    staging_capacity: usize,
}

/// Audio-thread-owned engine and bounded render-block command application.
pub struct Processor {
    shared: Arc<SharedQueues>,
    engine: LoopEngine,
    block_budget: usize,
    block_sequence: u64,
    rendered_frames: u64,
    observed_generation: u64,
    capture_discontinuities: u64,
}

impl Processor {
    pub fn controlled(samples: usize, sample_rate: u32) -> (CommandAdapter, Self) {
        Self::controlled_with_limits(
            samples,
            sample_rate,
            DEFAULT_COMMAND_CAPACITY,
            DEFAULT_ACK_CAPACITY,
            DEFAULT_BLOCK_BUDGET,
        )
    }

    pub fn controlled_with_limits(
        samples: usize,
        sample_rate: u32,
        command_capacity: usize,
        ack_capacity: usize,
        block_budget: usize,
    ) -> (CommandAdapter, Self) {
        assert!(command_capacity > 0 && ack_capacity > 0 && block_budget > 0);
        let shared = Arc::new(SharedQueues {
            audio: Arc::new(ArrayQueue::new(command_capacity)),
            outcomes: Arc::new(ArrayQueue::new(ack_capacity)),
            outstanding: Arc::new(AtomicUsize::new(0)),
            generation: Arc::new(AtomicU64::new(1)),
            active: Arc::new(AtomicBool::new(true)),
            next_command_id: AtomicU64::new(1),
            ack_capacity,
        });
        let adapter = CommandAdapter {
            shared: Arc::clone(&shared),
            staging: VecDeque::with_capacity(command_capacity),
            staging_capacity: command_capacity,
        };
        let processor = Self {
            shared,
            engine: LoopEngine::with_capacity_and_sample_rate(samples, sample_rate),
            block_budget,
            block_sequence: 0,
            rendered_frames: 0,
            observed_generation: 1,
            capture_discontinuities: 0,
        };
        (adapter, processor)
    }

    pub fn process_block(&mut self, input: &[f32], output: &mut [f32], event: HostEvent) {
        self.block_sequence = self.block_sequence.saturating_add(1);
        let generation = self.shared.generation.load(Ordering::Acquire);
        if generation != self.observed_generation {
            self.engine.interrupt();
            self.observed_generation = generation;
        }
        if !self.shared.active.load(Ordering::Acquire) {
            self.invalidate_queued_commands();
            output.fill(0.0);
            self.rendered_frames = self.rendered_frames.saturating_add(output.len() as u64);
            return;
        }

        match event {
            HostEvent::DeviceFailed => {
                self.shared.active.store(false, Ordering::Release);
                self.observed_generation = self
                    .shared
                    .generation
                    .fetch_add(1, Ordering::AcqRel)
                    .wrapping_add(1);
                self.engine.interrupt();
                self.invalidate_queued_commands();
                output.fill(0.0);
                self.rendered_frames = self.rendered_frames.saturating_add(output.len() as u64);
                return;
            }
            HostEvent::CaptureLost => {
                self.capture_discontinuities = self.capture_discontinuities.saturating_add(1);
                let capture_active = self.engine.snapshot().tracks.iter().any(|track| {
                    matches!(track.state, TrackState::Recording | TrackState::Overdubbing)
                });
                if capture_active {
                    self.observed_generation = self
                        .shared
                        .generation
                        .fetch_add(1, Ordering::AcqRel)
                        .wrapping_add(1);
                    self.engine.interrupt();
                }
                // A lost capture block is never passed to the engine. With no
                // active capture, an empty input lets existing playback advance.
                self.engine.process(&[], output);
                self.rendered_frames = self.rendered_frames.saturating_add(output.len() as u64);
                return;
            }
            HostEvent::None => {}
        }

        // This length is the block-start cutoff. Commands published after this
        // read are intentionally left for the next block.
        let available_at_cutoff = self.shared.audio.len();
        let batch_len = available_at_cutoff.min(self.block_budget);
        for _ in 0..batch_len {
            let Some(envelope) = self.shared.audio.pop() else {
                break;
            };
            let current_generation = self.shared.generation.load(Ordering::Acquire);
            if envelope.accepted.generation != current_generation {
                publish_outcome(
                    &self.shared.outcomes,
                    CommandOutcome::Stale {
                        command_id: envelope.accepted.command_id,
                        generation: envelope.accepted.generation,
                    },
                );
            } else {
                self.apply(envelope.command);
                publish_outcome(
                    &self.shared.outcomes,
                    CommandOutcome::Applied {
                        command_id: envelope.accepted.command_id,
                        generation: current_generation,
                        application_frame: self.rendered_frames,
                        block_sequence: self.block_sequence,
                    },
                );
            }
        }
        self.engine.process(input, output);
        self.rendered_frames = self.rendered_frames.saturating_add(output.len() as u64);
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        self.engine.snapshot()
    }

    pub fn monitoring(&self) -> bool {
        self.engine.monitoring()
    }

    pub fn session_generation(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }

    pub fn block_sequence(&self) -> u64 {
        self.block_sequence
    }

    pub fn rendered_frames(&self) -> u64 {
        self.rendered_frames
    }

    pub fn capture_discontinuities(&self) -> u64 {
        self.capture_discontinuities
    }

    fn apply(&mut self, command: AudioCommand) {
        match command {
            AudioCommand::SetTrackGain { track_id, gain } => {
                self.engine.set_track_gain(track_id, gain)
            }
            AudioCommand::SetTrackMute { track_id, muted } => {
                self.engine.set_track_mute(track_id, muted)
            }
            AudioCommand::SetMasterGain(gain) => self.engine.set_master_gain(gain),
            AudioCommand::SetMonitoring(enabled) => self.engine.set_monitoring(enabled),
            AudioCommand::SetMode { track_id, mode } => self.engine.set_mode(track_id, mode),
            AudioCommand::Record(track_id) => self.engine.record(track_id),
            AudioCommand::Play(track_id) => self.engine.play(track_id),
            AudioCommand::StopTrack(track_id) => self.engine.stop_track(track_id),
            AudioCommand::StopTransport => self.engine.stop_transport(),
            AudioCommand::StartTracks => {
                let tracks = self.engine.snapshot().tracks;
                if tracks.iter().any(|track| {
                    matches!(
                        track.state,
                        TrackState::Recording | TrackState::Playing | TrackState::Overdubbing
                    )
                }) {
                    return;
                }
                for (track_id, track) in tracks.iter().enumerate() {
                    if track.state == TrackState::Stopped && track.can_play {
                        self.engine.play(track_id);
                    }
                }
            }
            AudioCommand::Clear(track_id) => self.engine.clear(track_id),
            AudioCommand::Reset => self.engine.reset(),
        }
    }

    fn invalidate_queued_commands(&mut self) {
        while let Some(envelope) = self.shared.audio.pop() {
            publish_outcome(
                &self.shared.outcomes,
                CommandOutcome::Stale {
                    command_id: envelope.accepted.command_id,
                    generation: envelope.accepted.generation,
                },
            );
        }
    }
}

impl CommandAdapter {
    pub fn submit(&mut self, command: AudioCommand) -> Result<AcceptedCommand, RejectReason> {
        if !self.shared.active.load(Ordering::Acquire) {
            return Err(RejectReason::Unavailable);
        }
        if !is_valid(command) {
            return Err(RejectReason::InvalidCommand);
        }
        let replaces_staged_gain = self.staging.back().is_some_and(|previous| {
            previous.accepted.generation == self.session_generation()
                && is_same_gain_run(previous.command, command)
        });
        if (!replaces_staged_gain && self.staging.len() == self.staging_capacity)
            || !self.reserve_outcome()
        {
            return Err(RejectReason::Overloaded);
        }
        let accepted = AcceptedCommand {
            command_id: self.shared.next_command_id.fetch_add(1, Ordering::Relaxed),
            generation: self.shared.generation.load(Ordering::Acquire),
        };
        let envelope = Envelope { accepted, command };
        if let Some(previous) = self.staging.back_mut() {
            if previous.accepted.generation == accepted.generation
                && is_same_gain_run(previous.command, command)
            {
                let superseded = *previous;
                *previous = envelope;
                publish_outcome(
                    &self.shared.outcomes,
                    CommandOutcome::Superseded {
                        command_id: superseded.accepted.command_id,
                        generation: superseded.accepted.generation,
                        replacement_command_id: accepted.command_id,
                    },
                );
                return Ok(accepted);
            }
        }
        self.staging.push_back(envelope);
        Ok(accepted)
    }

    /// Move at most `limit` staged commands to the immutable audio queue.
    pub fn flush(&mut self, limit: usize) -> usize {
        let mut handed_off = 0;
        let mut examined = 0;
        while examined < limit {
            let Some(envelope) = self.staging.pop_front() else {
                break;
            };
            examined += 1;
            if envelope.accepted.generation != self.session_generation() {
                publish_outcome(
                    &self.shared.outcomes,
                    CommandOutcome::Stale {
                        command_id: envelope.accepted.command_id,
                        generation: envelope.accepted.generation,
                    },
                );
                continue;
            }
            match self.shared.audio.push(envelope) {
                Ok(()) => handed_off += 1,
                Err(envelope) => {
                    self.staging.push_front(envelope);
                    break;
                }
            }
        }
        handed_off
    }

    pub fn take_outcome(&self) -> Option<CommandOutcome> {
        let outcome = self.shared.outcomes.pop()?;
        self.shared.outstanding.fetch_sub(1, Ordering::AcqRel);
        Some(outcome)
    }

    pub fn session_generation(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }

    pub fn shutdown(&mut self) {
        self.shared.active.store(false, Ordering::Release);
        self.shared.generation.fetch_add(1, Ordering::AcqRel);
        while let Some(envelope) = self.staging.pop_front() {
            publish_outcome(
                &self.shared.outcomes,
                CommandOutcome::Stale {
                    command_id: envelope.accepted.command_id,
                    generation: envelope.accepted.generation,
                },
            );
        }
    }

    pub fn restart(&mut self) {
        self.shared.generation.fetch_add(1, Ordering::AcqRel);
        self.shared.active.store(true, Ordering::Release);
    }

    fn reserve_outcome(&self) -> bool {
        self.shared
            .outstanding
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < self.shared.ack_capacity).then_some(current + 1)
            })
            .is_ok()
    }
}

fn publish_outcome(outcomes: &ArrayQueue<CommandOutcome>, outcome: CommandOutcome) {
    outcomes
        .push(outcome)
        .expect("accepted work reserved terminal acknowledgement capacity");
}

fn is_valid(command: AudioCommand) -> bool {
    let valid_track = |track_id| track_id < 2;
    match command {
        AudioCommand::SetTrackGain { track_id, gain } => {
            valid_track(track_id) && gain.is_finite() && (0.0..=1.0).contains(&gain)
        }
        AudioCommand::SetTrackMute { track_id, .. }
        | AudioCommand::SetMode { track_id, .. }
        | AudioCommand::Record(track_id)
        | AudioCommand::Play(track_id)
        | AudioCommand::StopTrack(track_id)
        | AudioCommand::Clear(track_id) => valid_track(track_id),
        AudioCommand::SetMasterGain(gain) => gain.is_finite() && (0.0..=1.0).contains(&gain),
        AudioCommand::SetMonitoring(_)
        | AudioCommand::StopTransport
        | AudioCommand::StartTracks
        | AudioCommand::Reset => true,
    }
}

fn is_same_gain_run(previous: AudioCommand, next: AudioCommand) -> bool {
    match (previous, next) {
        (
            AudioCommand::SetTrackGain {
                track_id: previous_id,
                ..
            },
            AudioCommand::SetTrackGain {
                track_id: next_id, ..
            },
        ) => previous_id == next_id,
        (AudioCommand::SetMasterGain(_), AudioCommand::SetMasterGain(_)) => true,
        _ => false,
    }
}
