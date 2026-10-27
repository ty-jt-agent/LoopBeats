//! Controlled native command scheduler around the portable `LoopEngine`.
//!
//! The adapter owns bounded staging and UI lifecycle. `Processor` owns the engine
//! and is the only type that mutates it while rendering. The queues are allocated
//! at construction; render-block work uses bounded, allocation-free operations.
use crossbeam_queue::ArrayQueue;
use loop_engine::{
    EngineSnapshot, FxConfig, ImportMetadata, ImportTrack, LoopEngine, PlaybackMode, TrackState,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

pub const DEFAULT_COMMAND_CAPACITY: usize = 64;
pub const DEFAULT_ACK_CAPACITY: usize = 128;
pub const DEFAULT_BLOCK_BUDGET: usize = 16;
const PUBLISHERS_CLOSED: usize = 1 << (usize::BITS - 1);
const PUBLISHER_CLEANUP_REQUIRED: usize = PUBLISHERS_CLOSED >> 1;
const PUBLISHER_COUNT_MASK: usize = PUBLISHER_CLEANUP_REQUIRED - 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AudioCommand {
    SetTrackGain { track_id: usize, gain: f32 },
    SetTrackMute { track_id: usize, muted: bool },
    SetMasterGain(f32),
    SetFx { scope: usize, config: FxConfig },
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
    StaleGeneration,
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
    Failed {
        command_id: u64,
        generation: u64,
    },
}

impl CommandOutcome {
    pub fn command_id(self) -> u64 {
        match self {
            Self::Applied { command_id, .. }
            | Self::Superseded { command_id, .. }
            | Self::Stale { command_id, .. }
            | Self::Failed { command_id, .. } => command_id,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostEvent {
    None,
    CaptureLost,
    DeviceFailed,
}

/// A stopped, in-memory copy of retained engine audio for device stream recovery.
/// It is built and restored outside the render callback.
pub struct RetainedSession {
    pub metadata: ImportMetadata,
    pub tracks: [Vec<f32>; 2],
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
    publisher_state: AtomicUsize,
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
    published_snapshot: Arc<ArrayQueue<EngineSnapshot>>,
    published_frames: Arc<AtomicU64>,
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

    pub fn controlled_with_session(
        samples: usize,
        sample_rate: u32,
        session: Option<&RetainedSession>,
    ) -> Result<(CommandAdapter, Self), String> {
        let (commands, mut processor) = Self::controlled(samples, sample_rate);
        if let Some(session) = session {
            processor.restore_retained_session(session)?;
        }
        Ok((commands, processor))
    }

    /// Copy stopped recordings for an explicit device recovery operation.
    /// This performs bounded reads but may allocate; callers must use it only
    /// after the render loop has stopped processing.
    pub fn export_retained_session(&self) -> Option<RetainedSession> {
        let snapshot = self.engine.snapshot();
        if snapshot
            .tracks
            .iter()
            .any(|track| matches!(track.state, TrackState::Recording | TrackState::Overdubbing))
        {
            return None;
        }
        let metadata = ImportMetadata {
            fx: snapshot.fx.map(|slot| slot.config),
            cycle_length: snapshot.cycle_length_samples,
            master_gain: snapshot.master_gain,
            tracks: snapshot.tracks.map(|track| ImportTrack {
                length: track.length_samples,
                mode: track.mode,
                gain: track.gain,
                muted: track.muted,
            }),
        };
        let mut tracks = [Vec::new(), Vec::new()];
        for (track_id, audio) in tracks.iter_mut().enumerate() {
            let track = snapshot.tracks[track_id];
            audio.reserve(track.length_samples);
            let mut offset = 0;
            while offset < track.length_samples {
                let count = (track.length_samples - offset).min(2048);
                let mut block = vec![0.0; count];
                if !self.engine.read_recording(
                    track_id,
                    self.engine.recording_revision(track_id),
                    offset,
                    &mut block,
                ) {
                    return None;
                }
                audio.extend_from_slice(&block);
                offset += count;
            }
        }
        Some(RetainedSession { metadata, tracks })
    }

    fn restore_retained_session(&mut self, session: &RetainedSession) -> Result<(), String> {
        if session.tracks.each_ref().map(|samples| samples.len())
            != session.metadata.tracks.map(|track| track.length)
        {
            return Err("retained audio metadata does not match its sample data".into());
        }
        let revision = self.engine.command_revision();
        if !self.engine.begin_import(session.metadata, revision) {
            return Err("retained audio is incompatible with the recovered device".into());
        }
        for (track_id, samples) in session.tracks.iter().enumerate() {
            for (block_index, block) in samples.chunks(2048).enumerate() {
                if !self
                    .engine
                    .write_import(track_id, block_index * 2048, block)
                {
                    self.engine.cancel_import();
                    return Err("retained audio could not be restored".into());
                }
            }
        }
        if !self.engine.commit_import() {
            self.engine.cancel_import();
            return Err("retained audio could not be committed".into());
        }
        self.publish_snapshot();
        Ok(())
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
            publisher_state: AtomicUsize::new(0),
            next_command_id: AtomicU64::new(1),
            ack_capacity,
        });
        let published_snapshot = Arc::new(ArrayQueue::new(1));
        let published_frames = Arc::new(AtomicU64::new(0));
        let adapter = CommandAdapter {
            shared: Arc::clone(&shared),
            staging: VecDeque::with_capacity(command_capacity),
            staging_capacity: command_capacity,
        };
        let processor = Self {
            shared,
            published_snapshot,
            published_frames,
            engine: LoopEngine::with_capacity_and_sample_rate(samples, sample_rate),
            block_budget,
            block_sequence: 0,
            rendered_frames: 0,
            observed_generation: 1,
            capture_discontinuities: 0,
        };
        processor.publish_snapshot();
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
            self.publish_snapshot();
            return;
        }

        match event {
            HostEvent::DeviceFailed => {
                self.shared.publisher_state.fetch_or(
                    PUBLISHERS_CLOSED | PUBLISHER_CLEANUP_REQUIRED,
                    Ordering::AcqRel,
                );
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
                self.publish_snapshot();
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
                self.publish_snapshot();
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
                if self.apply(envelope.command) {
                    publish_outcome(
                        &self.shared.outcomes,
                        CommandOutcome::Applied {
                            command_id: envelope.accepted.command_id,
                            generation: current_generation,
                            application_frame: self.rendered_frames,
                            block_sequence: self.block_sequence,
                        },
                    );
                } else {
                    publish_outcome(
                        &self.shared.outcomes,
                        CommandOutcome::Failed {
                            command_id: envelope.accepted.command_id,
                            generation: current_generation,
                        },
                    );
                }
            }
        }
        self.engine.process(input, output);
        self.rendered_frames = self.rendered_frames.saturating_add(output.len() as u64);
        self.publish_snapshot();
    }

    fn publish_snapshot(&self) {
        self.published_frames
            .store(self.rendered_frames, Ordering::Release);
        let snapshot = self.engine.snapshot();
        let _ = self.published_snapshot.pop();
        let _ = self.published_snapshot.push(snapshot);
    }

    pub fn take_published_snapshot(&self) -> Option<EngineSnapshot> {
        let mut latest = None;
        while let Some(snapshot) = self.published_snapshot.pop() {
            latest = Some(snapshot);
        }
        latest
    }

    pub fn snapshot_feed(&self) -> Arc<ArrayQueue<EngineSnapshot>> {
        Arc::clone(&self.published_snapshot)
    }

    pub fn rendered_frames_feed(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.published_frames)
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

    /// Finish queue cleanup after a device failure. Call outside the render
    /// block, after admission has closed, so in-flight adapter publications
    /// cannot arrive behind the processor's real-time failure drain.
    pub fn settle_pending_after_failure(&mut self) {
        if self.shared.active.load(Ordering::Acquire) {
            return;
        }
        while self.shared.publisher_state.load(Ordering::Acquire) & PUBLISHER_COUNT_MASK != 0 {
            std::hint::spin_loop();
        }
        self.invalidate_queued_commands();
        self.shared
            .publisher_state
            .fetch_and(!PUBLISHER_CLEANUP_REQUIRED, Ordering::Release);
    }

    fn apply(&mut self, command: AudioCommand) -> bool {
        match command {
            AudioCommand::SetTrackGain { track_id, gain } => {
                self.engine.set_track_gain(track_id, gain)
            }
            AudioCommand::SetTrackMute { track_id, muted } => {
                self.engine.set_track_mute(track_id, muted)
            }
            AudioCommand::SetMasterGain(gain) => self.engine.set_master_gain(gain),
            AudioCommand::SetFx { scope, config } => {
                return match scope {
                    0 => self.engine.set_input_fx(config),
                    1 | 2 => self.engine.set_track_fx(scope - 1, config),
                    3 => self.engine.set_master_fx(config),
                    _ => return false,
                }
                .is_ok();
            }
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
                    return true;
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
        true
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
        self.submit_checked(command, None)
    }

    /// Admit a command only if it originated in the currently observed session.
    /// The accepted envelope keeps that same generation if a concurrent host
    /// fault advances the session immediately after this check.
    pub fn submit_for_generation(
        &mut self,
        command: AudioCommand,
        expected_generation: u64,
    ) -> Result<AcceptedCommand, RejectReason> {
        self.submit_checked(command, Some(expected_generation))
    }

    fn submit_checked(
        &mut self,
        command: AudioCommand,
        expected_generation: Option<u64>,
    ) -> Result<AcceptedCommand, RejectReason> {
        let Some(_publisher) = PublisherGuard::try_new(&self.shared.publisher_state) else {
            return Err(RejectReason::Unavailable);
        };
        if !self.shared.active.load(Ordering::Acquire) {
            return Err(RejectReason::Unavailable);
        }
        let generation = self.shared.generation.load(Ordering::Acquire);
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err(RejectReason::StaleGeneration);
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
            generation,
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
        self.flush_with_hook(limit, || {})
    }

    fn flush_with_hook(&mut self, limit: usize, mut before_publish: impl FnMut()) -> usize {
        let Some(_publisher) = PublisherGuard::try_new(&self.shared.publisher_state) else {
            self.settle_staged_commands();
            return 0;
        };
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
            before_publish();
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

    pub fn take_outcome(&mut self) -> Option<CommandOutcome> {
        if !self.shared.active.load(Ordering::Acquire) {
            self.settle_staged_commands();
        }
        let outcome = self.shared.outcomes.pop()?;
        self.shared.outstanding.fetch_sub(1, Ordering::AcqRel);
        Some(outcome)
    }

    pub fn session_generation(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }

    pub fn shutdown(&mut self) {
        self.shared
            .publisher_state
            .fetch_or(PUBLISHERS_CLOSED, Ordering::AcqRel);
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
        self.shared
            .publisher_state
            .fetch_or(PUBLISHERS_CLOSED, Ordering::AcqRel);
        loop {
            let state = self.shared.publisher_state.load(Ordering::Acquire);
            if state & (PUBLISHER_CLEANUP_REQUIRED | PUBLISHER_COUNT_MASK) == 0 {
                self.shared.generation.fetch_add(1, Ordering::AcqRel);
                self.shared.active.store(true, Ordering::Release);
                if self
                    .shared
                    .publisher_state
                    .compare_exchange(PUBLISHERS_CLOSED, 0, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    return;
                }
                self.shared.active.store(false, Ordering::Release);
            } else {
                std::hint::spin_loop();
            }
        }
    }

    fn settle_staged_commands(&mut self) {
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

    fn reserve_outcome(&self) -> bool {
        self.shared
            .outstanding
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < self.shared.ack_capacity).then_some(current + 1)
            })
            .is_ok()
    }
}

struct PublisherGuard<'a>(&'a AtomicUsize);

impl<'a> PublisherGuard<'a> {
    fn try_new(state: &'a AtomicUsize) -> Option<Self> {
        state
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                if current & PUBLISHERS_CLOSED != 0
                    || current & PUBLISHER_COUNT_MASK == PUBLISHER_COUNT_MASK
                {
                    None
                } else {
                    Some(current + 1)
                }
            })
            .ok()
            .map(|_| Self(state))
    }
}

impl Drop for PublisherGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
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
        AudioCommand::SetFx { scope, config } => {
            scope < 4
                && match config {
                    FxConfig::None => true,
                    FxConfig::LowPass { cutoff_hz, .. } => cutoff_hz.is_finite() && cutoff_hz > 0.0,
                }
        }
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

#[cfg(test)]
mod publication_failure_tests {
    use super::*;
    use std::{sync::Barrier, thread};

    #[test]
    fn failure_settles_a_command_published_after_the_render_drain() {
        let (mut adapter, mut processor) = Processor::controlled(16, 48_000);
        let in_flight = adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
        let still_staged = adapter.submit(AudioCommand::SetMasterGain(0.25)).unwrap();
        let entered_publish = Arc::new(Barrier::new(2));
        let resume_publish = Arc::new(Barrier::new(2));
        let thread_entered = Arc::clone(&entered_publish);
        let thread_resume = Arc::clone(&resume_publish);

        let flush_thread = thread::spawn(move || {
            let handed_off = adapter.flush_with_hook(1, || {
                thread_entered.wait();
                thread_resume.wait();
            });
            (adapter, handed_off)
        });

        entered_publish.wait();
        processor.process_block(&[], &mut [], HostEvent::DeviceFailed);
        resume_publish.wait();
        let (mut adapter, handed_off) = flush_thread.join().unwrap();
        assert_eq!(handed_off, 1);

        processor.settle_pending_after_failure();
        assert_eq!(
            adapter.submit(AudioCommand::SetMonitoring(false)),
            Err(RejectReason::Unavailable)
        );
        let outcomes = [
            adapter.take_outcome().unwrap(),
            adapter.take_outcome().unwrap(),
        ];
        assert_eq!(
            outcomes,
            [
                CommandOutcome::Stale {
                    command_id: in_flight.command_id,
                    generation: in_flight.generation,
                },
                CommandOutcome::Stale {
                    command_id: still_staged.command_id,
                    generation: still_staged.generation,
                },
            ]
        );
        assert_eq!(adapter.take_outcome(), None);
    }
}
