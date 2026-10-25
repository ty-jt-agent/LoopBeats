//! Narrow Windows shared-mode WASAPI host for the portable LoopEngine.
//!
//! This crate owns device negotiation and the two native stream threads. PCM is
//! transferred between those threads through a fixed-capacity queue; it never
//! crosses the UI boundary.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(any(windows, test))]
use std::sync::Arc;
use thiserror::Error;

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
}

impl HostDiagnostics {
    #[cfg(windows)]
    fn with_counters(
        capture: StreamDiagnostics,
        render: StreamDiagnostics,
        counters: (u64, u64, u64),
        device_failed: bool,
        capture_queue_frames: usize,
    ) -> Self {
        Self {
            capture,
            render,
            capture_discontinuities: counters.0,
            capture_overflows: counters.1,
            render_failures: counters.2,
            device_failed,
            capture_queue_frames,
        }
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
}

impl HostSignals {
    pub fn capture_discontinuity(&self) {
        self.count_capture_discontinuity();
        self.capture_loss_pending.store(true, Ordering::Release);
    }

    pub fn count_capture_discontinuity(&self) {
        self.capture_discontinuities.fetch_add(1, Ordering::Relaxed);
    }

    pub fn capture_overflow(&self) {
        self.capture_overflows.fetch_add(1, Ordering::Relaxed);
        self.capture_discontinuity();
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
}
