//! Narrow Windows shared-mode WASAPI host for the portable LoopEngine.
//!
//! This crate owns device negotiation and the two native stream threads. PCM is
//! transferred between those threads through a fixed-capacity queue; it never
//! crosses the UI boundary.

use loop_engine::TrackState;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(any(windows, test))]
use std::sync::Arc;
use thiserror::Error;

/// Run the scheduler's terminal device-failure transition before its processor
/// is dropped by a failed stream worker.
#[cfg(any(windows, test))]
fn settle_runtime_failure(processor: &mut native_audio_host::Processor) {
    process_runtime_failure(processor);
    processor.settle_pending_after_failure();
}

#[cfg(any(windows, test))]
fn process_runtime_failure(processor: &mut native_audio_host::Processor) {
    processor.process_block(&[], &mut [], native_audio_host::HostEvent::DeviceFailed);
}

#[cfg(windows)]
mod wasapi_host;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FallbackReason {
    LowPeriodUnsupported,
    IAudioClient3Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitializationFailure {
    Busy,
    Disconnected,
    Unsupported,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamDiagnostics {
    pub direction: StreamDirection,
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub adapter_name: String,
    pub driver: DriverDiagnostic,
    pub requested_sample_rate: u32,
    pub actual_sample_rate: u32,
    pub requested_period_frames: u32,
    pub actual_period_frames: u32,
    pub buffer_frames: u32,
    pub fallback: Option<FallbackReason>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DriverDiagnostic {
    Available {
        name: String,
        version: Option<String>,
    },
    Unavailable {
        reason: &'static str,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamDirection {
    Capture,
    Render,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SharedPeriodRange {
    pub minimum: u32,
    pub fundamental: u32,
    pub maximum: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeriodQueryFailure {
    InterfaceUnavailable,
    Other(InitializationFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LowPeriodFailure {
    UnsupportedPeriod,
    Other(InitializationFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NegotiatedPeriod {
    pub requested_frames: u32,
    pub actual_frames: u32,
    pub buffer_frames: u32,
    pub fallback: Option<FallbackReason>,
}

/// Small seam for deterministic tests of the two-step WASAPI negotiation.
pub trait SharedModeNegotiator {
    fn query_period_range(&mut self) -> Result<SharedPeriodRange, PeriodQueryFailure>;
    fn initialize_low_period(&mut self, frames: u32) -> Result<(u32, u32), LowPeriodFailure>;
    fn initialize_regular_shared(&mut self) -> Result<(u32, u32), InitializationFailure>;
}

pub fn negotiate_shared_mode(
    backend: &mut impl SharedModeNegotiator,
) -> Result<NegotiatedPeriod, InitializationFailure> {
    let range = match backend.query_period_range() {
        Ok(range) => range,
        Err(PeriodQueryFailure::InterfaceUnavailable) => {
            let (actual_frames, buffer_frames) = backend.initialize_regular_shared()?;
            return Ok(NegotiatedPeriod {
                requested_frames: 0,
                actual_frames,
                buffer_frames,
                fallback: Some(FallbackReason::IAudioClient3Unavailable),
            });
        }
        Err(PeriodQueryFailure::Other(failure)) => return Err(failure),
    };
    let requested_frames = requested_low_period(range.minimum, range.fundamental, range.maximum)
        .map_err(|_| InitializationFailure::Unsupported)?;
    match backend.initialize_low_period(requested_frames) {
        Ok((actual_frames, buffer_frames)) => Ok(NegotiatedPeriod {
            requested_frames,
            actual_frames,
            buffer_frames,
            fallback: None,
        }),
        Err(LowPeriodFailure::UnsupportedPeriod) => {
            let (actual_frames, buffer_frames) = backend.initialize_regular_shared()?;
            Ok(NegotiatedPeriod {
                requested_frames,
                actual_frames,
                buffer_frames,
                fallback: Some(FallbackReason::LowPeriodUnsupported),
            })
        }
        Err(LowPeriodFailure::Other(failure)) => Err(failure),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostDiagnostics {
    pub capture: StreamDiagnostics,
    pub render: StreamDiagnostics,
    pub capture_discontinuities: u64,
    pub capture_overflows: u64,
    pub render_failures: u64,
    pub device_failed: bool,
    pub capture_queue_frames: usize,
    pub last_capture_discontinuity: Option<CaptureDiscontinuityReason>,
    pub last_capture_impact: Option<CaptureLossImpact>,
    pub pending_capture_interruption: CaptureInterruptionNotices,
}

impl HostDiagnostics {
    #[cfg(windows)]
    fn with_counters(
        capture: StreamDiagnostics,
        render: StreamDiagnostics,
        counters: (u64, u64, u64),
        device_failed: bool,
        capture_queue_frames: usize,
        last_capture_discontinuity: Option<CaptureDiscontinuityReason>,
        last_capture_impact: Option<CaptureLossImpact>,
        pending_capture_interruption: CaptureInterruptionNotices,
    ) -> Self {
        Self {
            capture,
            render,
            capture_discontinuities: counters.0,
            capture_overflows: counters.1,
            render_failures: counters.2,
            device_failed,
            capture_queue_frames,
            last_capture_discontinuity,
            last_capture_impact,
            pending_capture_interruption,
        }
    }
}

/// The latest confirmed reason capture continuity was lost. Audio workers store
/// it atomically; callers read it through host diagnostics outside callbacks.
#[repr(u64)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureDiscontinuityReason {
    WasapiReported = 0,
    CapturePacketGap = 1,
    CaptureQueueOverflow = 2,
    RenderInputUnderflow = 3,
}

/// The session-level effect of a confirmed capture discontinuity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureLossImpact {
    PlaybackContinued,
    InitialRecordingDiscarded { track_id: usize },
    OverdubMayBePartial { track_id: usize },
}

/// Sticky capture-interruption consequences, retained until explicitly
/// acknowledged by a diagnostics consumer. Track IDs map to array indices.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CaptureInterruptionNotices {
    pub initial_recording_discarded_tracks: [bool; 2],
    pub overdub_may_be_partial_tracks: [bool; 2],
}

impl CaptureInterruptionNotices {
    fn decode(encoded: u64) -> Self {
        Self {
            initial_recording_discarded_tracks: [encoded & 1 != 0, encoded & 2 != 0],
            overdub_may_be_partial_tracks: [encoded & 4 != 0, encoded & 8 != 0],
        }
    }
}

pub fn capture_loss_impact(states: [TrackState; 2]) -> CaptureLossImpact {
    for (track_id, state) in states.into_iter().enumerate() {
        match state {
            TrackState::Recording => {
                return CaptureLossImpact::InitialRecordingDiscarded { track_id };
            }
            TrackState::Overdubbing => {
                return CaptureLossImpact::OverdubMayBePartial { track_id };
            }
            TrackState::Empty | TrackState::Playing | TrackState::Stopped => {}
        }
    }
    CaptureLossImpact::PlaybackContinued
}

fn encode_capture_loss_impact(impact: CaptureLossImpact) -> u64 {
    match impact {
        CaptureLossImpact::PlaybackContinued => 1,
        CaptureLossImpact::InitialRecordingDiscarded { track_id: 0 } => 2,
        CaptureLossImpact::InitialRecordingDiscarded { track_id: 1 } => 3,
        CaptureLossImpact::OverdubMayBePartial { track_id: 0 } => 4,
        CaptureLossImpact::OverdubMayBePartial { track_id: 1 } => 5,
        CaptureLossImpact::InitialRecordingDiscarded { .. }
        | CaptureLossImpact::OverdubMayBePartial { .. } => 0,
    }
}

fn decode_capture_loss_impact(encoded: u64) -> Option<CaptureLossImpact> {
    match encoded {
        1 => Some(CaptureLossImpact::PlaybackContinued),
        2 => Some(CaptureLossImpact::InitialRecordingDiscarded { track_id: 0 }),
        3 => Some(CaptureLossImpact::InitialRecordingDiscarded { track_id: 1 }),
        4 => Some(CaptureLossImpact::OverdubMayBePartial { track_id: 0 }),
        5 => Some(CaptureLossImpact::OverdubMayBePartial { track_id: 1 }),
        _ => None,
    }
}

/// Classify only loss evidence reported by WASAPI or a discontinuous packet
/// position. Callback timing and queue occupancy are deliberately not inputs.
pub fn capture_packet_discontinuity(
    wasapi_reported: bool,
    prior_packet_end: Option<u64>,
    packet_index: u64,
) -> Option<CaptureDiscontinuityReason> {
    if wasapi_reported {
        Some(CaptureDiscontinuityReason::WasapiReported)
    } else if prior_packet_end.is_some_and(|expected| expected != packet_index) {
        Some(CaptureDiscontinuityReason::CapturePacketGap)
    } else {
        None
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum HostError {
    #[error("native WASAPI monitoring is available only on Windows")]
    UnsupportedPlatform,
    #[error("audio endpoint initialization failed: {0:?}")]
    Initialization(InitializationFailure),
    #[error("selected endpoint has the wrong WASAPI direction")]
    WrongEndpointDirection,
    #[error("capture and render endpoints use different sample rates ({capture} and {render})")]
    SampleRateMismatch { capture: u32, render: u32 },
    #[error("unsupported endpoint sample format")]
    UnsupportedFormat,
    #[error("audio host thread failed to start: {0}")]
    ThreadStart(String),
    #[error("invalid audio host capacity configuration")]
    InvalidConfiguration,
}

/// Pick the first endpoint-supported period at or above the minimum. WASAPI's
/// minimum should already be fundamental-aligned, but validate that contract.
pub fn requested_low_period(
    minimum: u32,
    fundamental: u32,
    maximum: u32,
) -> Result<u32, HostError> {
    if minimum == 0 || fundamental == 0 || minimum > maximum {
        return Err(HostError::UnsupportedFormat);
    }
    let requested = (minimum as u64).div_ceil(fundamental as u64) * fundamental as u64;
    if requested > maximum as u64 {
        return Err(HostError::UnsupportedFormat);
    }
    Ok(requested as u32)
}

pub fn unsupported_period_hresult(hresult: i32) -> bool {
    hresult as u32 == 0x88890020 // AUDCLNT_E_INVALID_DEVICE_PERIOD
}

/// Shared lifecycle and diagnostic counters. Atomics keep the audio paths free
/// of locks and allow UI polling to read a consistent-enough diagnostic view.
#[derive(Default)]
pub struct HostSignals {
    capture_discontinuities: AtomicU64,
    capture_overflows: AtomicU64,
    render_failures: AtomicU64,
    capture_loss_pending: AtomicBool,
    device_failed: AtomicBool,
    last_capture_discontinuity: AtomicU64,
    last_capture_impact: AtomicU64,
    pending_capture_interruption: AtomicU64,
}

impl HostSignals {
    pub fn capture_discontinuity(&self, reason: CaptureDiscontinuityReason) {
        self.record_capture_discontinuity(reason);
        self.capture_loss_pending.store(true, Ordering::Release);
    }

    pub fn record_capture_discontinuity(&self, reason: CaptureDiscontinuityReason) {
        self.capture_discontinuities.fetch_add(1, Ordering::Relaxed);
        self.last_capture_discontinuity
            .store(reason as u64 + 1, Ordering::Release);
    }

    pub fn capture_overflow(&self) {
        self.capture_overflows.fetch_add(1, Ordering::Relaxed);
        self.capture_discontinuity(CaptureDiscontinuityReason::CaptureQueueOverflow);
    }

    pub fn render_failure(&self) {
        self.render_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn take_capture_loss(&self) -> bool {
        self.capture_loss_pending.swap(false, Ordering::AcqRel)
    }

    pub fn mark_device_failed(&self) {
        self.device_failed.store(true, Ordering::Release);
    }

    pub fn device_failed(&self) -> bool {
        self.device_failed.load(Ordering::Acquire)
    }

    pub fn counters(&self) -> (u64, u64, u64) {
        (
            self.capture_discontinuities.load(Ordering::Acquire),
            self.capture_overflows.load(Ordering::Acquire),
            self.render_failures.load(Ordering::Acquire),
        )
    }

    pub fn last_capture_discontinuity(&self) -> Option<CaptureDiscontinuityReason> {
        match self.last_capture_discontinuity.load(Ordering::Acquire) {
            1 => Some(CaptureDiscontinuityReason::WasapiReported),
            2 => Some(CaptureDiscontinuityReason::CapturePacketGap),
            3 => Some(CaptureDiscontinuityReason::CaptureQueueOverflow),
            4 => Some(CaptureDiscontinuityReason::RenderInputUnderflow),
            _ => None,
        }
    }

    pub fn record_capture_impact(&self, impact: CaptureLossImpact) {
        self.last_capture_impact
            .store(encode_capture_loss_impact(impact), Ordering::Release);
        let notice = match impact {
            CaptureLossImpact::PlaybackContinued => 0,
            CaptureLossImpact::InitialRecordingDiscarded { track_id: 0 } => 1,
            CaptureLossImpact::InitialRecordingDiscarded { track_id: 1 } => 2,
            CaptureLossImpact::OverdubMayBePartial { track_id: 0 } => 4,
            CaptureLossImpact::OverdubMayBePartial { track_id: 1 } => 8,
            CaptureLossImpact::InitialRecordingDiscarded { .. }
            | CaptureLossImpact::OverdubMayBePartial { .. } => 0,
        };
        self.pending_capture_interruption
            .fetch_or(notice, Ordering::AcqRel);
    }

    pub fn last_capture_impact(&self) -> Option<CaptureLossImpact> {
        decode_capture_loss_impact(self.last_capture_impact.load(Ordering::Acquire))
    }

    pub fn pending_capture_interruption(&self) -> CaptureInterruptionNotices {
        CaptureInterruptionNotices::decode(
            self.pending_capture_interruption.load(Ordering::Acquire),
        )
    }

    /// Acknowledge all capture interruptions observed so far. Any concurrent
    /// interruption after this swap remains pending for the next poll.
    pub fn acknowledge_capture_interruption(&self) -> CaptureInterruptionNotices {
        CaptureInterruptionNotices::decode(
            self.pending_capture_interruption.swap(0, Ordering::AcqRel),
        )
    }
}

/// Owns native stream threads and performs the shared stop-and-join lifecycle.
#[cfg(any(windows, test))]
pub(crate) struct WorkerGroup {
    stop: Arc<AtomicBool>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

#[cfg(any(windows, test))]
impl WorkerGroup {
    pub(crate) fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            threads: Vec::with_capacity(2),
        }
    }

    pub(crate) fn stop_signal(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    pub(crate) fn push(&mut self, thread: std::thread::JoinHandle<()>) {
        self.threads.push(thread);
    }

    pub(crate) fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

#[cfg(any(windows, test))]
impl Drop for WorkerGroup {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn classify_initialization_failure(hresult: i32) -> InitializationFailure {
    match hresult as u32 {
        0x8889000A => InitializationFailure::Busy, // AUDCLNT_E_DEVICE_IN_USE
        0x88890004 | 0x8889000F | 0x88890026 => InitializationFailure::Disconnected,
        0x88890008 | 0x88890019 | 0x88890020 => InitializationFailure::Unsupported,
        _ => InitializationFailure::Other,
    }
}

#[cfg(windows)]
pub use wasapi_host::{HostConfig, MonitoringHost};

#[cfg(not(windows))]
pub struct HostConfig;

#[cfg(not(windows))]
pub struct MonitoringHost;

#[cfg(not(windows))]
impl MonitoringHost {
    pub fn start(_: HostConfig) -> Result<Self, HostError> {
        Err(HostError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeNegotiator {
        range: Result<SharedPeriodRange, PeriodQueryFailure>,
        low: Result<(u32, u32), LowPeriodFailure>,
        regular: Result<(u32, u32), InitializationFailure>,
        low_calls: usize,
        regular_calls: usize,
    }

    impl SharedModeNegotiator for FakeNegotiator {
        fn query_period_range(&mut self) -> Result<SharedPeriodRange, PeriodQueryFailure> {
            self.range
        }

        fn initialize_low_period(&mut self, _: u32) -> Result<(u32, u32), LowPeriodFailure> {
            self.low_calls += 1;
            self.low
        }

        fn initialize_regular_shared(&mut self) -> Result<(u32, u32), InitializationFailure> {
            self.regular_calls += 1;
            self.regular
        }
    }

    fn fake_negotiator() -> FakeNegotiator {
        FakeNegotiator {
            range: Ok(SharedPeriodRange {
                minimum: 64,
                fundamental: 32,
                maximum: 512,
            }),
            low: Ok((64, 128)),
            regular: Ok((480, 960)),
            low_calls: 0,
            regular_calls: 0,
        }
    }

    #[test]
    fn classifies_wasapi_initialization_failures_without_conflating_busy_and_disconnect() {
        assert_eq!(
            classify_initialization_failure(0x8889000A_u32 as i32),
            InitializationFailure::Busy
        );
        assert_eq!(
            classify_initialization_failure(0x88890004_u32 as i32),
            InitializationFailure::Disconnected
        );
        assert_eq!(
            classify_initialization_failure(0x88890008_u32 as i32),
            InitializationFailure::Unsupported
        );
        assert_eq!(
            classify_initialization_failure(0x80004005_u32 as i32),
            InitializationFailure::Other
        );
    }

    #[test]
    fn shutdown_signal_is_idempotent_and_diagnostics_are_counted() {
        let signals = HostSignals::default();
        signals.capture_overflow();
        assert_eq!(signals.counters(), (1, 1, 0));
        assert_eq!(
            signals.last_capture_discontinuity(),
            Some(CaptureDiscontinuityReason::CaptureQueueOverflow)
        );
    }

    #[test]
    fn packet_continuity_uses_loss_evidence_not_callback_timing_or_occupancy() {
        assert_eq!(capture_packet_discontinuity(false, None, 12), None);
        assert_eq!(capture_packet_discontinuity(false, Some(12), 12), None);
        assert_eq!(
            capture_packet_discontinuity(false, Some(12), 15),
            Some(CaptureDiscontinuityReason::CapturePacketGap)
        );
        assert_eq!(
            capture_packet_discontinuity(true, Some(12), 12),
            Some(CaptureDiscontinuityReason::WasapiReported)
        );
        let signals = HostSignals::default();
        assert!(!signals.take_capture_loss());
        assert_eq!(signals.last_capture_discontinuity(), None);
    }

    #[test]
    fn capture_loss_diagnostics_preserve_recording_discard_and_partial_overdub_labels() {
        let impacts = [
            (
                [TrackState::Recording, TrackState::Playing],
                CaptureLossImpact::InitialRecordingDiscarded { track_id: 0 },
            ),
            (
                [TrackState::Stopped, TrackState::Overdubbing],
                CaptureLossImpact::OverdubMayBePartial { track_id: 1 },
            ),
            (
                [TrackState::Playing, TrackState::Stopped],
                CaptureLossImpact::PlaybackContinued,
            ),
        ];

        let signals = HostSignals::default();
        assert_eq!(signals.last_capture_impact(), None);
        for (states, expected) in impacts {
            assert_eq!(capture_loss_impact(states), expected);
            signals.record_capture_impact(expected);
            assert_eq!(signals.last_capture_impact(), Some(expected));
        }
    }

    #[test]
    fn delayed_diagnostics_poll_keeps_partial_overdub_notice_after_playback_loss() {
        use native_audio_host::{AudioCommand, HostEvent, Processor};

        let (mut commands, mut processor) = Processor::controlled(16, 48_000);
        let mut output = [0.0; 4];
        for (command, input) in [
            (AudioCommand::Record(0), &[0.25, 0.5][..]),
            (AudioCommand::Record(0), &[][..]),
            (AudioCommand::Record(0), &[0.25][..]),
        ] {
            commands.submit(command).unwrap();
            assert_eq!(commands.flush(1), 1);
            processor.process_block(input, &mut output[..input.len().max(1)], HostEvent::None);
            commands.take_outcome().unwrap();
        }
        assert_eq!(
            processor.snapshot().tracks[0].state,
            TrackState::Overdubbing
        );

        let signals = HostSignals::default();
        let impact = capture_loss_impact(processor.snapshot().tracks.map(|track| track.state));
        assert_eq!(
            impact,
            CaptureLossImpact::OverdubMayBePartial { track_id: 0 }
        );
        signals.record_capture_impact(impact);
        processor.process_block(&[0.9], &mut output[..1], HostEvent::CaptureLost);

        // A later underflow occurs after the capture has stopped. Diagnostics
        // are deliberately read only after that playback-only recovery block.
        let later_impact =
            capture_loss_impact(processor.snapshot().tracks.map(|track| track.state));
        assert_eq!(later_impact, CaptureLossImpact::PlaybackContinued);
        signals.record_capture_impact(later_impact);
        processor.process_block(&[], &mut output[..1], HostEvent::CaptureLost);

        assert_eq!(
            signals.last_capture_impact(),
            Some(CaptureLossImpact::PlaybackContinued)
        );
        assert_eq!(
            signals.pending_capture_interruption(),
            CaptureInterruptionNotices {
                initial_recording_discarded_tracks: [false; 2],
                overdub_may_be_partial_tracks: [true, false],
            }
        );
        assert_eq!(
            signals.acknowledge_capture_interruption(),
            CaptureInterruptionNotices {
                initial_recording_discarded_tracks: [false; 2],
                overdub_may_be_partial_tracks: [true, false],
            }
        );
        assert_eq!(
            signals.pending_capture_interruption(),
            CaptureInterruptionNotices::default()
        );
    }

    #[test]
    fn worker_group_starts_and_joins_both_stream_threads_on_shutdown() {
        use std::sync::atomic::AtomicUsize;
        use std::thread;
        use std::time::Duration;

        let mut workers = WorkerGroup::new();
        let stop = workers.stop_signal();
        let completed = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let stop = Arc::clone(&stop);
            let completed = Arc::clone(&completed);
            workers.push(thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(1));
                }
                completed.fetch_add(1, Ordering::Relaxed);
            }));
        }
        workers.shutdown();
        assert_eq!(completed.load(Ordering::Acquire), 2);
        assert!(stop.load(Ordering::Acquire));
    }

    #[test]
    fn requests_a_valid_fundamental_aligned_lowest_period() {
        assert_eq!(requested_low_period(127, 64, 256), Ok(128));
        assert_eq!(requested_low_period(64, 64, 128), Ok(64));
        assert_eq!(
            requested_low_period(129, 64, 128),
            Err(HostError::UnsupportedFormat)
        );
    }

    #[test]
    fn only_unsupported_period_hresult_is_eligible_for_fallback() {
        assert!(unsupported_period_hresult(0x88890020_u32 as i32));
        assert!(!unsupported_period_hresult(0x88890008_u32 as i32));
        assert!(!unsupported_period_hresult(0x8889000A_u32 as i32));
        assert!(!unsupported_period_hresult(0x88890004_u32 as i32));
        assert!(!unsupported_period_hresult(0x80004005_u32 as i32));
    }

    #[test]
    fn negotiates_lowest_period_and_falls_back_only_for_unsupported_period() {
        let mut low = fake_negotiator();
        assert_eq!(
            negotiate_shared_mode(&mut low),
            Ok(NegotiatedPeriod {
                requested_frames: 64,
                actual_frames: 64,
                buffer_frames: 128,
                fallback: None,
            })
        );
        assert_eq!((low.low_calls, low.regular_calls), (1, 0));

        let mut fallback = fake_negotiator();
        fallback.low = Err(LowPeriodFailure::UnsupportedPeriod);
        assert_eq!(
            negotiate_shared_mode(&mut fallback).unwrap().fallback,
            Some(FallbackReason::LowPeriodUnsupported)
        );
        assert_eq!((fallback.low_calls, fallback.regular_calls), (1, 1));
    }

    #[test]
    fn does_not_fallback_for_busy_or_disconnected_period_initialization() {
        for failure in [
            InitializationFailure::Busy,
            InitializationFailure::Disconnected,
            InitializationFailure::Unsupported,
        ] {
            let mut backend = fake_negotiator();
            backend.low = Err(LowPeriodFailure::Other(failure));
            assert_eq!(negotiate_shared_mode(&mut backend), Err(failure));
            assert_eq!((backend.low_calls, backend.regular_calls), (1, 0));
        }
    }

    #[test]
    fn missing_iaudioclient3_uses_regular_shared_mode_with_an_explicit_reason() {
        let mut backend = fake_negotiator();
        backend.range = Err(PeriodQueryFailure::InterfaceUnavailable);
        let result = negotiate_shared_mode(&mut backend).unwrap();
        assert_eq!(result.requested_frames, 0);
        assert_eq!(
            result.fallback,
            Some(FallbackReason::IAudioClient3Unavailable)
        );
        assert_eq!((backend.low_calls, backend.regular_calls), (0, 1));
    }

    #[test]
    fn native_command_scheduler_integrates_with_engine_and_shutdown() {
        use loop_engine::TrackState;
        use native_audio_host::{AudioCommand, HostEvent, Processor, RejectReason};

        let (mut commands, mut processor) = Processor::controlled(64, 48_000);
        commands.submit(AudioCommand::Record(0)).unwrap();
        assert_eq!(commands.flush(1), 1);
        let mut output = [0.0; 8];
        processor.process_block(&[0.25; 8], &mut output, HostEvent::None);
        assert_eq!(processor.snapshot().tracks[0].state, TrackState::Recording);
        commands.shutdown();
        assert_eq!(
            commands.submit(AudioCommand::Play(0)),
            Err(RejectReason::Unavailable)
        );
    }

    #[test]
    fn runtime_failure_settles_accepted_commands_and_closes_admission() {
        use native_audio_host::{AudioCommand, CommandOutcome, Processor, RejectReason};

        let (mut commands, mut processor) = Processor::controlled(64, 48_000);
        let handed_off = commands.submit(AudioCommand::SetMonitoring(true)).unwrap();
        let staged = commands.submit(AudioCommand::SetMasterGain(0.25)).unwrap();
        commands.flush(1);

        settle_runtime_failure(&mut processor);

        assert_eq!(processor.session_generation(), handed_off.generation + 1);
        assert_eq!(
            commands.submit(AudioCommand::SetMonitoring(false)),
            Err(RejectReason::Unavailable)
        );
        assert_eq!(
            commands.take_outcome(),
            Some(CommandOutcome::Stale {
                command_id: handed_off.command_id,
                generation: handed_off.generation,
            })
        );
        assert_eq!(
            commands.take_outcome(),
            Some(CommandOutcome::Stale {
                command_id: staged.command_id,
                generation: staged.generation,
            })
        );
    }
}
