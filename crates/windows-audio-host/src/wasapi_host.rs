use super::*;
use crossbeam_queue::ArrayQueue;
use loop_engine::{EngineSnapshot, TrackState};
use native_audio_host::{CommandAdapter, HostEvent, Processor};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;
use wasapi::{
    deinitialize, initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode,
    TimingMode, WaveFormat,
};
use windows::Win32::Foundation::{WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Threading::WaitForSingleObject;

const CAPTURE_QUEUE_FRAMES: usize = 16_384;

struct ComApartment;

impl ComApartment {
    fn enter() -> Result<Self, HostError> {
        if initialize_mta().is_err() {
            return Err(HostError::Initialization(InitializationFailure::Other));
        }
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        deinitialize();
    }
}

struct RunningStream<'a>(&'a AudioClient);

impl Drop for RunningStream<'_> {
    fn drop(&mut self) {
        let _ = self.0.stop_stream();
    }
}

#[derive(Default)]
pub struct HostConfig {
    pub capture_endpoint_id: Option<String>,
    pub render_endpoint_id: Option<String>,
    /// Override the usual 60-second engine capacity when the harness needs it.
    pub engine_capacity_frames: Option<usize>,
}

pub struct MonitoringHost {
    pub commands: CommandAdapter,
    pub signals: Arc<HostSignals>,
    capture_diagnostics: StreamDiagnostics,
    render_diagnostics: StreamDiagnostics,
    workers: WorkerGroup,
    input: Arc<ArrayQueue<f32>>,
    clock_correction_ppm: Arc<AtomicI32>,
    snapshot_feed: Arc<ArrayQueue<EngineSnapshot>>,
    latest_engine_snapshot: Option<EngineSnapshot>,
    rendered_frames: Arc<AtomicU64>,
}

impl MonitoringHost {
    pub fn start(config: HostConfig) -> Result<Self, HostError> {
        let (capture_id, render_id, capture_rate, render_rate) = resolve_endpoints(&config)?;
        let capacity = config
            .engine_capacity_frames
            .unwrap_or(render_rate as usize * 60);
        if capacity == 0 {
            return Err(HostError::InvalidConfiguration);
        }
        let (commands, processor) = Processor::controlled(capacity, render_rate);
        let snapshot_feed = processor.snapshot_feed();
        let rendered_frames = processor.rendered_frames_feed();
        let signals = Arc::new(HostSignals::default());
        let mut workers = WorkerGroup::new();
        let stop = workers.stop_signal();
        let input = Arc::new(ArrayQueue::new(CAPTURE_QUEUE_FRAMES));
        let ready = std::sync::mpsc::sync_channel(2);

        let capture_signals = Arc::clone(&signals);
        let capture_stop = Arc::clone(&stop);
        let capture_failure_signals = Arc::clone(&signals);
        let capture_failure_stop = Arc::clone(&stop);
        let capture_input = Arc::clone(&input);
        let capture_packet_frames = Arc::new(AtomicUsize::new(0));
        let capture_packet_frames_worker = Arc::clone(&capture_packet_frames);
        let capture_tx = ready.0.clone();
        let capture_thread = thread::Builder::new()
            .name("loopbeats-wasapi-capture".into())
            .spawn(move || {
                let result = run_capture(
                    &capture_id,
                    capture_input,
                    capture_packet_frames_worker,
                    capture_signals,
                    capture_stop,
                    &capture_tx,
                );
                if let Err(error) = result {
                    capture_failure_signals.mark_device_failed();
                    capture_failure_stop.store(true, Ordering::Release);
                    eprintln!("WASAPI capture stopped: {error}");
                }
            })
            .map_err(|error| HostError::ThreadStart(error.to_string()))?;
        workers.push(capture_thread);

        let render_signals = Arc::clone(&signals);
        let render_stop = Arc::clone(&stop);
        let render_failure_signals = Arc::clone(&signals);
        let render_failure_stop = Arc::clone(&stop);
        let render_input = Arc::clone(&input);
        let clock_correction_ppm = Arc::new(AtomicI32::new(0));
        let render_clock_correction = Arc::clone(&clock_correction_ppm);
        let render_capture_packet_frames = Arc::clone(&capture_packet_frames);
        let render_tx = ready.0.clone();
        let render_thread = match thread::Builder::new()
            .name("loopbeats-wasapi-render-engine".into())
            .spawn(move || {
                let mut processor = processor;
                let result = run_render(
                    &render_id,
                    capture_rate,
                    &mut processor,
                    render_input,
                    render_clock_correction,
                    render_capture_packet_frames,
                    render_signals,
                    render_stop,
                    &render_tx,
                );
                if let Err(error) = result {
                    settle_runtime_failure(&mut processor);
                    render_failure_signals.mark_device_failed();
                    render_failure_signals.render_failure();
                    render_failure_stop.store(true, Ordering::Release);
                    eprintln!("WASAPI render stopped: {error}");
                } else if render_failure_signals.device_failed() {
                    processor.settle_pending_after_failure();
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                workers.shutdown();
                return Err(HostError::ThreadStart(error.to_string()));
            }
        };
        workers.push(render_thread);
        drop(ready.0);

        // Threads report that they are initialized before entering their loops.
        // Startup waits are on the control thread, never on either audio thread.
        let mut stream_diagnostics = Vec::with_capacity(2);
        for _ in 0..2 {
            match ready.1.recv_timeout(Duration::from_secs(15)) {
                Ok(Ok(diagnostics)) => stream_diagnostics.push(diagnostics),
                Ok(Err(error)) => {
                    workers.shutdown();
                    return Err(error);
                }
                Err(error) => {
                    workers.shutdown();
                    return Err(HostError::ThreadStart(error.to_string()));
                }
            }
        }
        Ok(Self {
            commands,
            signals,
            capture_diagnostics: stream_diagnostics
                .iter()
                .find(|d| d.direction == StreamDirection::Capture)
                .expect("capture thread reports capture diagnostics")
                .clone(),
            render_diagnostics: stream_diagnostics
                .iter()
                .find(|d| d.direction == StreamDirection::Render)
                .expect("render thread reports render diagnostics")
                .clone(),
            workers,
            input,
            clock_correction_ppm,
            snapshot_feed,
            latest_engine_snapshot: None,
            rendered_frames,
        })
    }

    pub fn shutdown(mut self) {
        self.commands.shutdown();
        self.workers.shutdown();
    }

    pub fn latest_snapshot(&mut self) -> Option<EngineSnapshot> {
        while let Some(snapshot) = self.snapshot_feed.pop() {
            self.latest_engine_snapshot = Some(snapshot);
        }
        self.latest_engine_snapshot
    }

    pub fn rendered_frames(&self) -> u64 {
        self.rendered_frames.load(Ordering::Acquire)
    }

    pub fn diagnostics(&self) -> HostDiagnostics {
        HostDiagnostics::with_counters(
            self.capture_diagnostics.clone(),
            self.render_diagnostics.clone(),
            self.signals.counters(),
            self.signals.device_failed(),
            self.input.len(),
            self.signals.last_capture_discontinuity(),
            self.signals.last_capture_impact(),
            self.signals.pending_capture_interruption(),
            CAPTURE_QUEUE_FRAMES,
            self.clock_correction_ppm.load(Ordering::Acquire),
        )
    }
}

impl Drop for MonitoringHost {
    fn drop(&mut self) {
        self.commands.shutdown();
        self.workers.shutdown();
    }
}

fn resolve_endpoints(config: &HostConfig) -> Result<(String, String, u32, u32), HostError> {
    let _com = ComApartment::enter()?;
    let resolved = (|| {
        let enumerator = DeviceEnumerator::new().map_err(map_error)?;
        let capture = match &config.capture_endpoint_id {
            Some(id) => enumerator.get_device(id),
            None => enumerator.get_default_device(&Direction::Capture),
        }
        .map_err(map_error)?;
        let render = match &config.render_endpoint_id {
            Some(id) => enumerator.get_device(id),
            None => enumerator.get_default_device(&Direction::Render),
        }
        .map_err(map_error)?;
        if capture.get_direction() != Direction::Capture
            || render.get_direction() != Direction::Render
        {
            return Err(HostError::WrongEndpointDirection);
        }
        let render_rate = render
            .get_iaudioclient()
            .and_then(|client| client.get_mixformat())
            .map_err(map_error)?
            .get_samplespersec();
        let capture_rate = capture
            .get_iaudioclient()
            .and_then(|client| client.get_mixformat())
            .map_err(map_error)?
            .get_samplespersec();
        Ok::<_, HostError>((
            capture.get_id().map_err(map_error)?,
            render.get_id().map_err(map_error)?,
            capture_rate,
            render_rate,
        ))
    })();
    let (capture_id, render_id, capture_rate, render_rate) = resolved?;
    Ok((capture_id, render_id, capture_rate, render_rate))
}

fn run_capture(
    endpoint_id: &str,
    samples: Arc<ArrayQueue<f32>>,
    capture_packet_frames: Arc<AtomicUsize>,
    signals: Arc<HostSignals>,
    stop: Arc<AtomicBool>,
    ready: &std::sync::mpsc::SyncSender<Result<StreamDiagnostics, HostError>>,
) -> Result<(), HostError> {
    let _com = match ComApartment::enter() {
        Ok(com) => com,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    let setup = (|| {
        let enumerator = DeviceEnumerator::new().map_err(map_error)?;
        let device = enumerator.get_device(endpoint_id).map_err(map_error)?;
        let mut client = device.get_iaudioclient().map_err(map_error)?;
        let format = client.get_mixformat().map_err(map_error)?;
        validate_format(&format)?;
        let period = negotiate(&mut client, &format)?;
        let event = client.set_get_eventhandle().map_err(map_error)?;
        let buffer_frames = client.get_buffer_size().map_err(map_error)? as usize;
        if buffer_frames == 0 || buffer_frames > CAPTURE_QUEUE_FRAMES {
            return Err(HostError::InvalidConfiguration);
        }
        let capture = client.get_audiocaptureclient().map_err(map_error)?;
        let diagnostics = make_diagnostics(
            &device,
            &format,
            period,
            buffer_frames,
            StreamDirection::Capture,
        );
        Ok::<_, HostError>((
            client,
            event,
            capture,
            format,
            buffer_frames,
            period.1,
            diagnostics,
        ))
    })();
    let (client, event, capture, format, buffer_frames, period_frames, diagnostics) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    let channels = format.get_nchannels() as usize;
    let bytes_per_frame = format.get_blockalign() as usize;
    let mut raw = vec![0_u8; buffer_frames.max(1) * bytes_per_frame];
    capture_packet_frames.store(period_frames as usize, Ordering::Release);
    if let Err(error) = client.start_stream().map_err(map_error) {
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let _running = RunningStream(&client);
    if ready.send(Ok(diagnostics)).is_err() {
        return Ok(());
    }
    let mut prior_index = None;
    while !stop.load(Ordering::Acquire) {
        match wait_for_event(&event) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => return Err(error),
        }
        loop {
            let packet = capture
                .get_next_packet_size()
                .map_err(map_error)?
                .unwrap_or(0) as usize;
            if packet == 0 {
                break;
            }
            if packet * bytes_per_frame > raw.len() {
                return Err(HostError::UnsupportedFormat);
            }
            let (frames, info) = capture.read_from_device(&mut raw).map_err(map_error)?;
            if let Some(reason) =
                capture_packet_discontinuity(info.flags.data_discontinuity, prior_index, info.index)
            {
                signals.capture_discontinuity(reason);
            }
            prior_index = Some(info.index.saturating_add(frames as u64));
            if info.flags.silent {
                for _ in 0..frames {
                    if !push_input(&samples, 0.0) {
                        signals.capture_overflow();
                        break;
                    }
                }
            } else {
                for frame in raw[..frames as usize * bytes_per_frame].chunks_exact(bytes_per_frame)
                {
                    let mono = decode_frame(frame, &format, channels)?;
                    if !push_input(&samples, mono) {
                        signals.capture_overflow();
                        break;
                    }
                }
            }
        }
    }
    Ok(())
}

fn run_render(
    endpoint_id: &str,
    capture_rate: u32,
    processor: &mut Processor,
    input: Arc<ArrayQueue<f32>>,
    clock_correction_ppm: Arc<AtomicI32>,
    capture_packet_frames: Arc<AtomicUsize>,
    signals: Arc<HostSignals>,
    stop: Arc<AtomicBool>,
    ready: &std::sync::mpsc::SyncSender<Result<StreamDiagnostics, HostError>>,
) -> Result<(), HostError> {
    let _com = match ComApartment::enter() {
        Ok(com) => com,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    let setup = (|| {
        let enumerator = DeviceEnumerator::new().map_err(map_error)?;
        let device = enumerator.get_device(endpoint_id).map_err(map_error)?;
        let mut client = device.get_iaudioclient().map_err(map_error)?;
        let format = client.get_mixformat().map_err(map_error)?;
        validate_format(&format)?;
        let period = negotiate(&mut client, &format)?;
        let event = client.set_get_eventhandle().map_err(map_error)?;
        let buffer_frames = client.get_buffer_size().map_err(map_error)? as usize;
        if buffer_frames == 0 || buffer_frames > CAPTURE_QUEUE_FRAMES {
            return Err(HostError::InvalidConfiguration);
        }
        let render = client.get_audiorenderclient().map_err(map_error)?;
        let diagnostics = make_diagnostics(
            &device,
            &format,
            period,
            buffer_frames,
            StreamDirection::Render,
        );
        Ok::<_, HostError>((
            client,
            event,
            render,
            format,
            period,
            buffer_frames,
            diagnostics,
        ))
    })();
    let (client, event, render, format, period, buffer_frames, diagnostics) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    let channels = format.get_nchannels() as usize;
    let bytes_per_frame = format.get_blockalign() as usize;
    let mut frames = vec![0.0_f32; buffer_frames.max(1)];
    let mut output = vec![0.0_f32; buffer_frames.max(1)];
    let mut raw = vec![0_u8; buffer_frames.max(1) * bytes_per_frame];
    let mut capture_resampler = CaptureResampler::new(capture_rate, format.get_samplespersec())?;
    let render_rate = format.get_samplespersec() as u64;
    let capture_packet_frames = loop {
        let frames = capture_packet_frames.load(Ordering::Acquire);
        if frames > 0 {
            break frames;
        }
        if stop.load(Ordering::Acquire) {
            let error = HostError::Initialization(InitializationFailure::Other);
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
        thread::yield_now();
    };
    let render_prefill_frames =
        (period.1 as u64 * capture_rate as u64 * 2).div_ceil(render_rate) as usize;
    let target_capture_frames = capture_packet_frames
        .saturating_add(render_prefill_frames)
        .clamp(2, CAPTURE_QUEUE_FRAMES - 1);
    if target_capture_frames.saturating_add(capture_packet_frames) > CAPTURE_QUEUE_FRAMES {
        let error = HostError::InvalidConfiguration;
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let mut clock_controller = CaptureClockController::new(target_capture_frames);
    // Let capture prime the bounded FIFO before opening the render clock. This
    // avoids treating the expected startup fill interval as a capture gap.
    while !stop.load(Ordering::Acquire) && input.len() < target_capture_frames {
        thread::yield_now();
    }
    if let Err(error) = client.start_stream().map_err(map_error) {
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let _running = RunningStream(&client);
    if ready.send(Ok(diagnostics)).is_err() {
        return Ok(());
    }
    loop {
        if stop.load(Ordering::Acquire) {
            if signals.device_failed() {
                process_runtime_failure(processor);
            }
            break;
        }
        match wait_for_event(&event) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => return Err(error),
        }
        let available = client.get_available_space_in_frames().map_err(map_error)? as usize;
        if available == 0 {
            continue;
        }
        if available > frames.len() {
            return Err(HostError::UnsupportedFormat);
        }
        if signals.device_failed() {
            process_runtime_failure(processor);
            break;
        }
        let capture_active =
            processor.snapshot().tracks.iter().any(|track| {
                matches!(track.state, TrackState::Recording | TrackState::Overdubbing)
            });
        let stale_frames_discarded = recover_capture_backlog(
            &input,
            target_capture_frames,
            capture_packet_frames,
            capture_active,
        );
        if stale_frames_discarded > 0 {
            capture_resampler.reset();
            signals
                .record_capture_discontinuity(CaptureDiscontinuityReason::CaptureBacklogDiscarded);
        }
        let correction = clock_controller.update_for_block(input.len(), available);
        clock_correction_ppm.store(clock_controller.correction_ppm(), Ordering::Release);
        let mut missing_input = false;
        for sample in &mut frames[..available] {
            let (resampled, missing) = capture_resampler.next_sample(&input, correction);
            *sample = if missing { 0.0 } else { resampled };
            missing_input |= missing;
        }
        let was_signaled_lost = signals.take_capture_loss();
        if missing_input && !was_signaled_lost {
            signals.record_capture_discontinuity(CaptureDiscontinuityReason::RenderInputUnderflow);
        }
        let event_kind = if missing_input || was_signaled_lost || stale_frames_discarded > 0 {
            HostEvent::CaptureLost
        } else {
            HostEvent::None
        };
        if event_kind == HostEvent::CaptureLost {
            let snapshot = processor.snapshot();
            signals.record_capture_impact(capture_loss_impact(
                snapshot.tracks.map(|track| track.state),
            ));
        }
        processor.process_block(&frames[..available], &mut output[..available], event_kind);
        encode_output(
            &output[..available],
            &format,
            channels,
            &mut raw[..available * bytes_per_frame],
        )?;
        if let Err(error) =
            render.write_to_device(available, &raw[..available * bytes_per_frame], None)
        {
            return Err(map_error(error));
        }
    }
    Ok(())
}

fn wait_for_event(event: &wasapi::Handle) -> Result<bool, HostError> {
    let result = unsafe { WaitForSingleObject(event.as_handle(), 50) };
    classify_wait_result(result)
}

fn classify_wait_result(result: WAIT_EVENT) -> Result<bool, HostError> {
    if result == WAIT_OBJECT_0 {
        Ok(true)
    } else if result == WAIT_TIMEOUT {
        Ok(false)
    } else {
        Err(HostError::Initialization(InitializationFailure::Other))
    }
}

fn negotiate(
    client: &mut AudioClient,
    format: &WaveFormat,
) -> Result<(u32, u32, Option<FallbackReason>), HostError> {
    let negotiated = negotiate_shared_mode(&mut WasapiNegotiator {
        client,
        format,
        has_audio_client3: false,
    })
    .map_err(HostError::Initialization)?;
    Ok((
        negotiated.requested_frames,
        negotiated.actual_frames,
        negotiated.fallback,
    ))
}

struct WasapiNegotiator<'a> {
    client: &'a mut AudioClient,
    format: &'a WaveFormat,
    has_audio_client3: bool,
}

impl SharedModeNegotiator for WasapiNegotiator<'_> {
    fn query_period_range(&mut self) -> Result<SharedPeriodRange, PeriodQueryFailure> {
        match self.client.get_shared_mode_engine_period(self.format) {
            Ok(range) => {
                self.has_audio_client3 = true;
                Ok(SharedPeriodRange {
                    minimum: range.min,
                    fundamental: range.fundamental,
                    maximum: range.max,
                })
            }
            Err(error) if is_unsupported_interface(&error) => {
                Err(PeriodQueryFailure::InterfaceUnavailable)
            }
            Err(error) => Err(PeriodQueryFailure::Other(classify_wasapi_error(&error))),
        }
    }

    fn initialize_low_period(&mut self, frames: u32) -> Result<(u32, u32), LowPeriodFailure> {
        self.client
            .initialize_shared_audio_stream(self.format, TimingMode::Events, frames)
            .map_err(|error| {
                if is_unsupported_period(&error) {
                    LowPeriodFailure::UnsupportedPeriod
                } else {
                    LowPeriodFailure::Other(classify_wasapi_error(&error))
                }
            })?;
        let (_, actual_frames) = self
            .client
            .get_current_shared_mode_engine_period()
            .map_err(|error| LowPeriodFailure::Other(classify_wasapi_error(&error)))?;
        let buffer_frames = self
            .client
            .get_buffer_size()
            .map_err(|error| LowPeriodFailure::Other(classify_wasapi_error(&error)))?;
        Ok((actual_frames, buffer_frames))
    }

    fn initialize_regular_shared(&mut self) -> Result<(u32, u32), InitializationFailure> {
        let (default_period_hns, minimum_hns) = self
            .client
            .get_device_period()
            .map_err(|error| classify_wasapi_error(&error))?;
        self.client
            .initialize_client(
                self.format,
                &self.client.get_direction(),
                &StreamMode::EventsShared {
                    autoconvert: false,
                    buffer_duration_hns: minimum_hns,
                },
            )
            .map_err(|error| classify_wasapi_error(&error))?;
        let actual_period_frames = if self.has_audio_client3 {
            self.client
                .get_current_shared_mode_engine_period()
                .map(|(_, frames)| frames)
                .map_err(|error| classify_wasapi_error(&error))?
        } else {
            period_frames(default_period_hns, self.format.get_samplespersec())
        };
        let buffer_frames = self
            .client
            .get_buffer_size()
            .map_err(|error| classify_wasapi_error(&error))?;
        Ok((actual_period_frames, buffer_frames))
    }
}

fn period_frames(duration_hns: i64, sample_rate: u32) -> u32 {
    ((duration_hns.max(0) as u64 * sample_rate as u64 + 5_000_000) / 10_000_000) as u32
}

fn make_diagnostics(
    device: &wasapi::Device,
    format: &WaveFormat,
    period: (u32, u32, Option<FallbackReason>),
    buffer_frames: usize,
    direction: StreamDirection,
) -> StreamDiagnostics {
    let sample_format =
        stream_sample_format(format).expect("stream format was validated before diagnostics");
    StreamDiagnostics {
        direction,
        endpoint_id: device.get_id().unwrap_or_else(|_| "unavailable".into()),
        endpoint_name: device
            .get_friendlyname()
            .unwrap_or_else(|_| "unavailable".into()),
        adapter_name: device
            .get_interface_friendlyname()
            .unwrap_or_else(|_| "unavailable".into()),
        driver: DriverDiagnostic::Unavailable {
            reason:
                "WASAPI does not expose the installed driver version; read it from Device Manager",
        },
        requested_sample_rate: format.get_samplespersec(),
        actual_sample_rate: format.get_samplespersec(),
        channel_count: format.get_nchannels(),
        sample_format,
        requested_period_frames: period.0,
        actual_period_frames: period.1,
        buffer_frames: buffer_frames as u32,
        fallback: period.2,
    }
}

fn is_unsupported_period(error: &wasapi::WasapiError) -> bool {
    match error {
        wasapi::WasapiError::Windows(error) => unsupported_period_hresult(error.code().0),
        _ => false,
    }
}

fn is_unsupported_interface(error: &wasapi::WasapiError) -> bool {
    match error {
        wasapi::WasapiError::Windows(error) => error.code().0 as u32 == 0x80004002, // E_NOINTERFACE
        _ => false,
    }
}

fn map_error(error: wasapi::WasapiError) -> HostError {
    match error {
        wasapi::WasapiError::UnsupportedFormat => HostError::UnsupportedFormat,
        error => HostError::Initialization(classify_wasapi_error(&error)),
    }
}

fn classify_wasapi_error(error: &wasapi::WasapiError) -> InitializationFailure {
    match error {
        wasapi::WasapiError::UnsupportedFormat => InitializationFailure::Unsupported,
        wasapi::WasapiError::DeviceNotFound(_) | wasapi::WasapiError::IllegalDeviceState(_) => {
            InitializationFailure::Disconnected
        }
        wasapi::WasapiError::Windows(error) => classify_initialization_failure(error.code().0),
        _ => InitializationFailure::Other,
    }
}

fn validate_format(format: &WaveFormat) -> Result<(), HostError> {
    let bits = format.get_bitspersample();
    if stream_sample_format(format).is_none()
        || format.get_validbitspersample() != bits
        || format.get_samplespersec() == 0
        || format.get_nchannels() == 0
        || format.get_blockalign() as usize != format.get_nchannels() as usize * (bits as usize / 8)
    {
        return Err(HostError::UnsupportedFormat);
    }
    Ok(())
}

fn stream_sample_format(format: &WaveFormat) -> Option<StreamSampleFormat> {
    match (format.get_subformat().ok()?, format.get_bitspersample()) {
        (SampleType::Float, 32) => Some(StreamSampleFormat::Float32),
        (SampleType::Int, 16) => Some(StreamSampleFormat::Signed16),
        (SampleType::Int, 24) => Some(StreamSampleFormat::Signed24),
        (SampleType::Int, 32) => Some(StreamSampleFormat::Signed32),
        _ => None,
    }
}

fn push_input(queue: &ArrayQueue<f32>, sample: f32) -> bool {
    queue.push(sample).is_ok()
}

fn decode_frame(frame: &[u8], format: &WaveFormat, channels: usize) -> Result<f32, HostError> {
    let width = format.get_bitspersample() as usize / 8;
    let mut total = 0.0_f32;
    for channel in 0..channels {
        let bytes = &frame[channel * width..(channel + 1) * width];
        let value = match (
            format
                .get_subformat()
                .map_err(|_| HostError::UnsupportedFormat)?,
            width,
        ) {
            (SampleType::Float, 4) => f32::from_le_bytes(bytes.try_into().unwrap()),
            (SampleType::Int, 2) => i16::from_le_bytes(bytes.try_into().unwrap()) as f32 / 32768.0,
            (SampleType::Int, 3) => {
                let raw = i32::from_le_bytes([
                    bytes[0],
                    bytes[1],
                    bytes[2],
                    if bytes[2] & 0x80 == 0 { 0 } else { 255 },
                ]);
                raw as f32 / 8_388_608.0
            }
            (SampleType::Int, 4) => {
                i32::from_le_bytes(bytes.try_into().unwrap()) as f32 / 2_147_483_648.0
            }
            _ => return Err(HostError::UnsupportedFormat),
        };
        total += if value.is_finite() { value } else { 0.0 };
    }
    Ok((total / channels as f32).clamp(-1.0, 1.0))
}

fn encode_output(
    input: &[f32],
    format: &WaveFormat,
    channels: usize,
    output: &mut [u8],
) -> Result<(), HostError> {
    let width = format.get_bitspersample() as usize / 8;
    for (frame_index, sample) in input.iter().copied().enumerate() {
        for channel in 0..channels {
            let bytes = &mut output[(frame_index * channels + channel) * width
                ..(frame_index * channels + channel + 1) * width];
            let sample = if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            match (
                format
                    .get_subformat()
                    .map_err(|_| HostError::UnsupportedFormat)?,
                width,
            ) {
                (SampleType::Float, 4) => bytes.copy_from_slice(&sample.to_le_bytes()),
                (SampleType::Int, 2) => {
                    bytes.copy_from_slice(&((sample * 32767.0) as i16).to_le_bytes())
                }
                (SampleType::Int, 3) => {
                    let raw = (sample * 8_388_607.0) as i32;
                    bytes.copy_from_slice(&raw.to_le_bytes()[..3]);
                }
                (SampleType::Int, 4) => {
                    bytes.copy_from_slice(&((sample * 2_147_483_647.0) as i32).to_le_bytes())
                }
                _ => return Err(HostError::UnsupportedFormat),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_stereo_integer_input_to_engine_mono_samples() {
        let format = WaveFormat::new(16, 16, &SampleType::Int, 48_000, 2, None);
        let decoded = decode_frame(&[0x00, 0x80, 0xff, 0x7f], &format, 2).unwrap();
        assert!((decoded - (-1.0 / 65536.0)).abs() < f32::EPSILON);
    }

    #[test]
    fn encodes_engine_samples_to_each_render_channel() {
        let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
        let mut bytes = [0; 8];
        encode_output(&[0.25], &format, 2, &mut bytes).unwrap();
        assert_eq!(&bytes[..4], &0.25_f32.to_le_bytes());
        assert_eq!(&bytes[4..], &0.25_f32.to_le_bytes());
    }

    #[test]
    fn bounded_capture_queue_reports_overflow_and_pending_loss() {
        let queue = ArrayQueue::new(1);
        let signals = HostSignals::default();
        assert!(push_input(&queue, 0.1));
        assert!(!push_input(&queue, 0.2));
        signals.capture_overflow();
        assert_eq!(signals.counters(), (1, 1, 0));
        assert!(signals.take_capture_loss());
        assert!(!signals.take_capture_loss());
    }

    #[test]
    fn event_wait_distinguishes_timeout_from_handle_failure() {
        assert_eq!(classify_wait_result(WAIT_OBJECT_0), Ok(true));
        assert_eq!(classify_wait_result(WAIT_TIMEOUT), Ok(false));
        assert_eq!(
            classify_wait_result(WAIT_EVENT(u32::MAX)),
            Err(HostError::Initialization(InitializationFailure::Other))
        );
    }
}
