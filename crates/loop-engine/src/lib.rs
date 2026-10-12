//! Browser-independent sample-authoritative recording and playback.
mod effects;
mod loop_buffer;
use effects::FxSlot;
pub use effects::{FxConfig, FxError, FxSnapshot};
use loop_buffer::LoopBuffer;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum TrackState {
    Empty,
    Recording,
    Playing,
    Stopped,
    Overdubbing,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum PlaybackMode {
    Loop,
    OneShot,
}
#[derive(Clone, Copy, Debug)]
pub struct TrackSnapshot {
    pub muted: bool,
    pub gain: f32,
    pub mode: PlaybackMode,
    pub can_set_mode: bool,
    pub can_set_loop: bool,
    pub state: TrackState,
    pub length_samples: usize,
    pub captured_samples: usize,
    pub position_samples: usize,
    pub capacity_samples: usize,
    pub capture_limit_samples: usize,
    pub can_record: bool,
    pub can_play: bool,
    pub can_stop: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct EngineSnapshot {
    pub fx: [FxSnapshot; 4],
    pub audio_failed: bool,
    pub master_gain: f32,
    pub tracks: [TrackSnapshot; 2],
    pub transport_running: bool,
    pub transport_position_samples: u64,
    pub cycle_length_samples: usize,
}
#[derive(Default)]
struct Transport {
    running: bool,
    position: u64,
    cycle_length: usize,
}
struct Track {
    revision: u32,
    muted: bool,
    gain: f32,
    mode: PlaybackMode,
    one_shot_position: usize,
    recording: LoopBuffer,
    state: TrackState,
    length: usize,
    captured: usize,
}
pub struct LoopEngine {
    fx: [FxSlot; 4],
    audio_failed: bool,
    command_revision: u32,
    staging: [Track; 2],
    import: Option<(ImportMetadata, u32, [usize; 2])>,
    checkpoint: Option<ImportMetadata>,
    master_gain: f32,
    monitoring: bool,
    tracks: [Track; 2],
    transport: Transport,
}
#[derive(Clone, Copy)]
pub struct ImportTrack {
    pub length: usize,
    pub mode: PlaybackMode,
    pub gain: f32,
    pub muted: bool,
}
#[derive(Clone, Copy)]
pub struct ImportMetadata {
    pub fx: [FxConfig; 4],
    pub cycle_length: usize,
    pub master_gain: f32,
    pub tracks: [ImportTrack; 2],
}
impl Default for LoopEngine {
    fn default() -> Self {
        Self::new()
    }
}
impl LoopEngine {
    pub fn new() -> Self {
        Self::with_sample_rate(48_000)
    }
    pub fn with_sample_rate(sample_rate: u32) -> Self {
        assert!((8_000..=192_000).contains(&sample_rate));
        Self::with_capacity_and_sample_rate(sample_rate as usize * 60, sample_rate)
    }
    /// Allocate capture storage during initialization, never processing.
    pub fn with_capacity(samples: usize) -> Self {
        Self::with_capacity_and_sample_rate(samples, 48_000)
    }
    pub fn with_capacity_and_sample_rate(samples: usize, sample_rate: u32) -> Self {
        assert!(samples > 0);
        assert!((8_000..=192_000).contains(&sample_rate));
        let bank = || {
            std::array::from_fn(|_| Track {
                revision: 0,
                muted: false,
                gain: 1.0,
                mode: PlaybackMode::Loop,
                one_shot_position: 0,
                recording: LoopBuffer::new(samples),
                state: TrackState::Empty,
                length: 0,
                captured: 0,
            })
        };
        Self {
            fx: std::array::from_fn(|_| FxSlot::new(sample_rate)),
            audio_failed: false,
            command_revision: 0,
            staging: bank(),
            import: None,
            checkpoint: None,
            master_gain: 1.0,
            monitoring: false,
            tracks: std::array::from_fn(|_| Track {
                revision: 0,
                muted: false,
                gain: 1.0,
                mode: PlaybackMode::Loop,
                one_shot_position: 0,
                recording: LoopBuffer::new(samples),
                state: TrackState::Empty,
                length: 0,
                captured: 0,
            }),
            transport: Transport::default(),
        }
    }
    pub fn command_revision(&self) -> u32 {
        self.command_revision
    }
    pub fn set_input_fx(&mut self, config: FxConfig) -> Result<(), FxError> {
        if self.audio_failed {
            return Err(FxError::Unavailable);
        }
        self.fx[0].set(config)?;
        self.mutate();
        Ok(())
    }
    pub fn set_track_fx(&mut self, track_id: usize, config: FxConfig) -> Result<(), FxError> {
        if self.audio_failed {
            return Err(FxError::Unavailable);
        }
        if track_id >= self.tracks.len() {
            return Err(FxError::Invalid);
        }
        self.fx[track_id + 1].set(config)?;
        self.mutate();
        Ok(())
    }
    fn mutate(&mut self) {
        self.command_revision = self.command_revision.saturating_add(1);
    }
    pub fn cancel_import(&mut self) {
        self.import = None;
    }
    pub fn begin_import(&mut self, metadata: ImportMetadata, revision: u32) -> bool {
        if self.checkpoint.is_some() {
            return false;
        }
        self.import = None;
        let capacity = self.tracks[0].recording.capacity();
        if revision == u32::MAX
            || self.audio_failed
            || metadata.fx.iter().any(|config| !self.fx[0].valid(*config))
            || revision != self.command_revision
            || metadata.cycle_length > capacity
            || !(0.0..=1.0).contains(&metadata.master_gain)
            || self
                .tracks
                .iter()
                .any(|t| matches!(t.state, TrackState::Recording | TrackState::Overdubbing))
            || metadata.tracks.iter().any(|t| {
                t.length > capacity
                    || !(0.0..=1.0).contains(&t.gain)
                    || (t.length > 0
                        && t.mode == PlaybackMode::Loop
                        && t.length != metadata.cycle_length)
            })
            || self
                .staging
                .iter()
                .any(|t| !t.recording.can_begin_capture())
        {
            return false;
        }
        for track in &mut self.staging {
            track.recording.begin_capture();
        }
        self.import = Some((metadata, revision, [0; 2]));
        true
    }
    pub fn write_import(&mut self, id: usize, offset: usize, samples: &[f32]) -> bool {
        let Some((metadata, revision, received)) = &mut self.import else {
            return false;
        };
        if id >= 2
            || *revision != self.command_revision
            || samples.is_empty()
            || samples.len() > 2048
            || offset != received[id]
            || offset > metadata.tracks[id].length
            || samples.len() > metadata.tracks[id].length - offset
            || samples.iter().any(|s| !s.is_finite())
        {
            return false;
        }
        for (i, sample) in samples.iter().enumerate() {
            self.staging[id].recording.write(offset + i, *sample);
        }
        received[id] += samples.len();
        true
    }
    pub fn commit_import(&mut self) -> bool {
        let Some((metadata, revision, received)) = self.import else {
            return false;
        };
        if revision != self.command_revision || received != metadata.tracks.map(|t| t.length) {
            return false;
        }
        for (id, config) in metadata.tracks.iter().enumerate() {
            let track = &mut self.staging[id];
            track.revision = self.tracks[id].revision.saturating_add(1);
            track.length = config.length;
            track.captured = config.length;
            track.mode = config.mode;
            track.gain = config.gain;
            track.muted = config.muted;
            track.one_shot_position = 0;
            track.state = if config.length == 0 {
                TrackState::Empty
            } else {
                TrackState::Stopped
            };
        }
        std::mem::swap(&mut self.tracks, &mut self.staging);
        self.transport = Transport {
            cycle_length: metadata.cycle_length,
            ..Transport::default()
        };
        self.master_gain = metadata.master_gain;
        for (slot, config) in self.fx.iter_mut().zip(metadata.fx) {
            slot.restore(config);
        }
        self.monitoring = false;
        self.import = None;
        self.mutate();
        true
    }
    pub fn set_monitoring(&mut self, enabled: bool) {
        self.mutate();
        self.monitoring = enabled;
    }
    /// Linear volume controls accept finite values from silence (0) to unity (1).
    pub fn set_track_gain(&mut self, track_id: usize, gain: f32) {
        self.mutate();
        if (0.0..=1.0).contains(&gain) {
            if let Some(track) = self.tracks.get_mut(track_id) {
                track.gain = gain;
            }
        }
    }
    pub fn set_track_mute(&mut self, track_id: usize, muted: bool) {
        self.mutate();
        if let Some(track) = self.tracks.get_mut(track_id) {
            track.muted = muted;
        }
    }
    pub fn set_master_gain(&mut self, gain: f32) {
        self.mutate();
        if (0.0..=1.0).contains(&gain) {
            self.master_gain = gain;
        }
    }
    pub fn monitoring(&self) -> bool {
        self.monitoring
    }
    /// Stable content identity for a bounded export. Exhausted identities fail closed.
    pub fn recording_revision(&self, track_id: usize) -> u32 {
        self.tracks.get(track_id).map_or(0, |track| track.revision)
    }
    /// Freeze metadata in constant time. Samples are preserved lazily before writes.
    pub fn begin_checkpoint(&mut self) -> Option<ImportMetadata> {
        if self.audio_failed {
            return None;
        }
        if self.import.is_some()
            || self.checkpoint.is_some()
            || self
                .staging
                .iter()
                .any(|t| !t.recording.can_begin_capture())
        {
            return None;
        }
        let tracks = std::array::from_fn(|id| {
            let track = &self.tracks[id];
            ImportTrack {
                length: if track.state == TrackState::Empty
                    || (track.state == TrackState::Recording && track.captured == 0)
                {
                    0
                } else {
                    track.length
                },
                mode: track.mode,
                gain: track.gain,
                muted: track.muted,
            }
        });
        let cycle_length = if self.transport.cycle_length == 0 {
            self.tracks
                .iter()
                .find(|t| {
                    t.state == TrackState::Recording
                        && t.mode == PlaybackMode::Loop
                        && t.captured > 0
                })
                .map_or(0, |t| t.captured)
        } else {
            self.transport.cycle_length
        };
        if tracks
            .iter()
            .any(|t| t.mode == PlaybackMode::Loop && t.length > 0 && t.length != cycle_length)
        {
            return None;
        }
        let metadata = ImportMetadata {
            fx: self.fx.each_ref().map(|slot| slot.snapshot().config),
            cycle_length,
            master_gain: self.master_gain,
            tracks,
        };
        for track in &mut self.staging {
            track.recording.begin_capture();
        }
        self.checkpoint = Some(metadata);
        Some(metadata)
    }
    pub fn checkpoint_metadata(&self) -> Option<ImportMetadata> {
        self.checkpoint
    }
    pub fn cancel_checkpoint(&mut self) {
        self.checkpoint = None;
    }
    fn freeze_position(&mut self, id: usize, position: usize) {
        if self
            .checkpoint
            .is_some_and(|m| position < m.tracks[id].length)
            && !self.staging[id].recording.is_written(position)
        {
            let value = self.tracks[id].recording.read(position);
            self.staging[id].recording.write(position, value);
        }
    }
    /// Bounded reads return the same boundary's raw audio despite subsequent capture.
    pub fn read_checkpoint(&mut self, id: usize, offset: usize, output: &mut [f32]) -> bool {
        let Some(metadata) = self.checkpoint else {
            return false;
        };
        if id >= 2
            || output.len() > 2048
            || offset > metadata.tracks[id].length
            || output.len() > metadata.tracks[id].length - offset
        {
            return false;
        }
        for (index, sample) in output.iter_mut().enumerate() {
            self.freeze_position(id, offset + index);
            *sample = self.staging[id].recording.read(offset + index);
            if !sample.is_finite() {
                self.cancel_checkpoint();
                return false;
            }
        }
        true
    }
    /// Read completed audio without exposing storage or allocating on the audio thread.
    pub fn read_recording(
        &self,
        track_id: usize,
        revision: u32,
        offset: usize,
        output: &mut [f32],
    ) -> bool {
        let Some(track) = self.tracks.get(track_id) else {
            return false;
        };
        if revision == u32::MAX
            || revision != track.revision
            || !matches!(track.state, TrackState::Playing | TrackState::Stopped)
            || output.len() > 2048
            || offset > track.length
            || output.len() > track.length - offset
        {
            return false;
        }
        for (index, sample) in output.iter_mut().enumerate() {
            *sample = track.recording.read(offset + index);
        }
        true
    }
    /// Select capture mode or convert a stopped recording without changing its samples.
    pub fn set_mode(&mut self, track_id: usize, mode: PlaybackMode) {
        self.mutate();
        let Some(availability) = self.snapshot().tracks.get(track_id).copied() else {
            return;
        };
        if !availability.can_set_mode || (mode == PlaybackMode::Loop && !availability.can_set_loop)
        {
            return;
        }
        let track = &mut self.tracks[track_id];
        track.mode = mode;
        track.one_shot_position = 0;
    }
    /// Invalid track indices and unavailable commands are ignored by the engine.
    pub fn record(&mut self, track_id: usize) {
        self.mutate();
        if track_id >= self.tracks.len() || !self.snapshot().tracks[track_id].can_record {
            return;
        }
        match self.tracks[track_id].state {
            TrackState::Recording => self.finish_recording(track_id, true),
            TrackState::Overdubbing => self.tracks[track_id].state = TrackState::Playing,
            TrackState::Playing | TrackState::Stopped => {
                if self.tracks[track_id].state == TrackState::Stopped {
                    self.fx[track_id + 1].clear_history();
                }
                self.tracks[track_id].revision = self.tracks[track_id].revision.saturating_add(1);
                if self.transport.cycle_length == 0 {
                    self.transport.cycle_length = self.tracks[track_id].length;
                    self.transport.position = 0;
                    self.transport.running = true;
                }
                self.tracks[track_id].state = TrackState::Overdubbing
            }
            TrackState::Empty => {
                self.cancel_checkpoint();
                let track = &mut self.tracks[track_id];
                track.revision = track.revision.saturating_add(1);
                track.recording.begin_capture();
                track.state = TrackState::Recording;
                track.length = if track.mode == PlaybackMode::Loop {
                    self.transport.cycle_length
                } else {
                    0
                };
                track.one_shot_position = 0;
                track.captured = 0;
            }
        }
    }

    fn finish_recording(&mut self, track_id: usize, play: bool) {
        self.fx[track_id + 1].clear_history();
        let track = &mut self.tracks[track_id];
        if track.captured == 0 {
            track.state = TrackState::Empty;
            track.length = 0;
            return;
        }
        track.revision = track.revision.saturating_add(1);
        if track.mode == PlaybackMode::OneShot {
            track.length = track.captured;
            track.one_shot_position = 0;
        }
        if track.mode == PlaybackMode::Loop && self.transport.cycle_length == 0 {
            track.length = track.captured;
            self.transport.cycle_length = track.length;
            self.transport.position = 0;
            self.transport.running = play;
        }
        track.state = if play {
            TrackState::Playing
        } else {
            TrackState::Stopped
        };
    }
    pub fn stop_track(&mut self, track_id: usize) {
        self.mutate();
        let Some(track) = self.tracks.get_mut(track_id) else {
            return;
        };
        self.fx[track_id + 1].clear_history();
        match track.state {
            TrackState::Recording => self.finish_recording(track_id, false),
            TrackState::Playing | TrackState::Overdubbing => track.state = TrackState::Stopped,
            TrackState::Empty | TrackState::Stopped => {}
        }
    }
    pub fn play(&mut self, track_id: usize) {
        self.mutate();
        if track_id >= self.tracks.len() || !self.snapshot().tracks[track_id].can_play {
            return;
        }
        let track = &mut self.tracks[track_id];
        if track.state == TrackState::Stopped || track.mode == PlaybackMode::OneShot {
            self.fx[track_id + 1].clear_history();
        }
        if track.mode == PlaybackMode::Loop && !self.transport.running {
            if self.transport.cycle_length == 0 {
                self.transport.cycle_length = track.length;
            }
            self.transport.position = 0;
            self.transport.running = true;
        }
        track.one_shot_position = 0;
        track.state = TrackState::Playing;
    }
    /// Remove a recording in constant time; fresh capture invalidates old storage lazily.
    pub fn clear(&mut self, track_id: usize) {
        self.mutate();
        if track_id < self.tracks.len() {
            self.cancel_checkpoint();
        }
        if let Some(track) = self.tracks.get_mut(track_id) {
            self.fx[track_id + 1].clear_history();
            track.revision = track.revision.saturating_add(1);
            track.state = TrackState::Empty;
            track.length = 0;
            track.captured = 0;
            track.one_shot_position = 0;
        }
    }
    /// Start a fresh audio workspace while retaining volume, mute and mode preferences.
    pub fn reset(&mut self) {
        self.mutate();
        for track_id in 0..self.tracks.len() {
            self.clear(track_id);
        }
        self.transport = Transport::default();
        self.monitoring = false;
        for slot in &mut self.fx {
            slot.reset();
        }
    }
    /// Stop safely for an input/context interruption without losing completed audio.
    pub fn interrupt(&mut self) {
        self.mutate();
        self.stop_transport();
        self.monitoring = false;
    }
    pub fn stop_transport(&mut self) {
        self.mutate();
        for slot in &mut self.fx {
            slot.clear_history();
        }
        if self.tracks.iter().any(|t| t.state == TrackState::Recording) {
            self.cancel_checkpoint();
        }
        for track in &mut self.tracks {
            track.one_shot_position = 0;
            match track.state {
                TrackState::Recording => {
                    track.state = TrackState::Empty;
                    track.length = 0;
                    track.captured = 0;
                }
                TrackState::Playing | TrackState::Overdubbing => track.state = TrackState::Stopped,
                TrackState::Empty | TrackState::Stopped => {}
            }
        }
        self.transport.running = false;
        self.transport.position = 0;
    }
    fn cycle_position(&self) -> usize {
        if self.transport.cycle_length == 0 {
            0
        } else {
            (self.transport.position % self.transport.cycle_length as u64) as usize
        }
    }
    pub fn snapshot(&self) -> EngineSnapshot {
        let capture_active = self
            .tracks
            .iter()
            .any(|track| matches!(track.state, TrackState::Recording | TrackState::Overdubbing));
        EngineSnapshot {
            fx: std::array::from_fn(|i| self.fx[i].snapshot()),
            audio_failed: self.audio_failed,
            master_gain: self.master_gain,
            tracks: std::array::from_fn(|index| {
                let track = &self.tracks[index];
                let compatible =
                    self.transport.cycle_length == 0 || track.length == self.transport.cycle_length;
                TrackSnapshot {
                    muted: track.muted,
                    gain: track.gain,
                    mode: track.mode,
                    can_set_mode: matches!(track.state, TrackState::Empty | TrackState::Stopped),
                    can_set_loop: matches!(track.state, TrackState::Empty | TrackState::Stopped)
                        && (track.state == TrackState::Empty
                            || self.transport.cycle_length == 0
                            || track.length == self.transport.cycle_length),
                    state: track.state,
                    length_samples: track.length,
                    captured_samples: track.captured,
                    position_samples: if track.mode == PlaybackMode::OneShot {
                        track.one_shot_position
                    } else {
                        self.cycle_position()
                    },
                    capacity_samples: track.recording.capacity(),
                    capture_limit_samples: if track.mode == PlaybackMode::OneShot
                        || self.transport.cycle_length == 0
                    {
                        track.recording.capacity()
                    } else {
                        self.transport.cycle_length
                    },
                    can_record: matches!(
                        track.state,
                        TrackState::Recording | TrackState::Overdubbing
                    ) || (!capture_active
                        && (self.transport.cycle_length == 0 || self.transport.running)
                        && ((track.state == TrackState::Empty
                            && track.recording.can_begin_capture())
                            || (track.state != TrackState::Empty
                                && track.mode == PlaybackMode::Loop
                                && compatible))),
                    can_play: (track.state == TrackState::Stopped
                        && (track.mode == PlaybackMode::OneShot || compatible))
                        || (track.mode == PlaybackMode::OneShot
                            && track.state == TrackState::Playing),
                    can_stop: matches!(
                        track.state,
                        TrackState::Recording | TrackState::Playing | TrackState::Overdubbing
                    ),
                }
            }),
            transport_running: self.transport.running,
            transport_position_samples: self.transport.position,
            cycle_length_samples: self.transport.cycle_length,
        }
    }
    pub fn process(&mut self, input: &[f32], output: &mut [f32]) {
        if self.audio_failed {
            output.fill(0.0);
            return;
        }
        for (index, destination) in output.iter_mut().enumerate() {
            let advance = self.transport.running;
            let phase = self.cycle_position();
            let Some(source) = self.fx[0].process(input.get(index).copied().unwrap_or(0.0)) else {
                self.fail_audio(output);
                return;
            };
            let mut sample = if self.monitoring {
                f64::from(source)
            } else {
                0.0
            };
            for track_id in 0..self.tracks.len() {
                let live = &self.tracks[track_id];
                let independent =
                    live.mode == PlaybackMode::OneShot || self.transport.cycle_length == 0;
                let capture_position = if live.state == TrackState::Recording && independent {
                    live.captured
                } else {
                    phase
                };
                if matches!(live.state, TrackState::Recording | TrackState::Overdubbing) {
                    self.freeze_position(track_id, capture_position);
                }
                let track = &mut self.tracks[track_id];
                let active = matches!(track.state, TrackState::Playing | TrackState::Overdubbing);
                let mut playback = 0.0;
                let mut ended = false;
                let gain = if track.muted { 0.0 } else { track.gain };
                match track.state {
                    TrackState::Empty | TrackState::Stopped => {}
                    TrackState::Recording => {
                        track.recording.write(capture_position, source);
                        track.captured += 1;
                        if independent {
                            track.length = track.captured;
                        }
                        let limit = if independent {
                            track.recording.capacity()
                        } else {
                            self.transport.cycle_length
                        };
                        if track.captured == limit {
                            self.finish_recording(track_id, true);
                        }
                    }
                    TrackState::Playing | TrackState::Overdubbing => {
                        let position = if track.mode == PlaybackMode::OneShot {
                            track.one_shot_position
                        } else {
                            phase
                        };
                        let previous = track.recording.read(position);
                        if track.state == TrackState::Overdubbing {
                            let mixed = previous + source;
                            if !mixed.is_finite() {
                                self.fail_audio(output);
                                return;
                            }
                            track.recording.write(phase, mixed);
                            playback = mixed;
                        } else {
                            playback = previous;
                            if track.mode == PlaybackMode::OneShot {
                                track.one_shot_position += 1;
                                if track.one_shot_position == track.length {
                                    track.state = TrackState::Stopped;
                                    ended = true;
                                }
                            }
                        }
                    }
                }
                // Inactive slots advance bounded edit/removal ramps with silence,
                // but contribute nothing. New playback clears history at its boundary.
                let Some(processed) = self.fx[track_id + 1].process_mix(f64::from(playback)) else {
                    self.fail_audio(output);
                    return;
                };
                if active {
                    sample += processed * f64::from(gain);
                }
                // The final One-shot sample contributes before its history is retired.
                if ended {
                    self.fx[track_id + 1].clear_history();
                }
            }
            let final_sample = sample * f64::from(self.master_gain);
            if !final_sample.is_finite() {
                self.fail_audio(output);
                return;
            }
            *destination = final_sample.clamp(-1.0, 1.0) as f32;
            if advance {
                self.transport.position += 1;
            }
        }
    }
    fn fail_audio(&mut self, output: &mut [f32]) {
        self.cancel_checkpoint();
        self.cancel_import();
        self.interrupt();
        self.audio_failed = true;
        output.fill(0.0);
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{FxConfig, FxError};
    use super::{ImportMetadata, ImportTrack};
    use super::{LoopEngine, PlaybackMode};
    const CAPACITY: usize = 2048;
    static mut INPUT: [f32; CAPACITY] = [0.0; CAPACITY];
    static mut OUTPUT: [f32; CAPACITY] = [0.0; CAPACITY];
    static mut ENGINE: Option<LoopEngine> = None;
    #[no_mangle]
    pub extern "C" fn initialize(sample_rate: usize) -> u32 {
        if !(8_000..=192_000).contains(&sample_rate) {
            return 0;
        }
        // SAFETY: called once by the serialized host before processing/views.
        unsafe {
            *core::ptr::addr_of_mut!(ENGINE) =
                Some(LoopEngine::with_sample_rate(sample_rate as u32));
        }
        1
    }
    // One initialized WASM instance is owned by one serialized worklet host.
    fn with_engine<T>(operation: impl FnOnce(&mut LoopEngine) -> T) -> T {
        // SAFETY: exports do not overlap and no engine reference escapes.
        unsafe { operation((*core::ptr::addr_of_mut!(ENGINE)).as_mut().unwrap()) }
    }
    #[no_mangle]
    pub extern "C" fn set_input_fx(kind: u32, cutoff_hz: f64, bypassed: u32) -> u32 {
        let config = match (kind, bypassed) {
            (0, 0) if cutoff_hz == 0.0 => FxConfig::None,
            (1, 0 | 1) => FxConfig::LowPass {
                cutoff_hz,
                bypassed: bypassed == 1,
            },
            _ => return FxError::Invalid as u32,
        };
        with_engine(|engine| {
            engine
                .set_input_fx(config)
                .err()
                .map_or(0, |error| error as u32)
        })
    }
    #[no_mangle]
    pub extern "C" fn set_track_fx(
        track_id: usize,
        kind: u32,
        cutoff_hz: f64,
        bypassed: u32,
    ) -> u32 {
        let config = match (kind, bypassed) {
            (0, 0) if cutoff_hz == 0.0 => FxConfig::None,
            (1, 0 | 1) => FxConfig::LowPass {
                cutoff_hz,
                bypassed: bypassed == 1,
            },
            _ => return FxError::Invalid as u32,
        };
        if track_id >= 2 {
            return FxError::Invalid as u32;
        }
        with_engine(|engine| {
            engine
                .set_track_fx(track_id, config)
                .err()
                .map_or(0, |error| error as u32)
        })
    }
    #[no_mangle]
    pub extern "C" fn fx_flags(scope: usize) -> u32 {
        with_engine(|engine| {
            engine.snapshot().fx.get(scope).map_or(0, |slot| {
                let flags = match slot.config {
                    FxConfig::None => 0,
                    FxConfig::LowPass { bypassed, .. } => 1 | ((bypassed as u32) << 1),
                };
                flags | ((slot.transitioning as u32) << 2) | ((slot.removing as u32) << 3)
            })
        })
    }
    #[no_mangle]
    pub extern "C" fn fx_cutoff(scope: usize) -> f64 {
        with_engine(|engine| {
            engine
                .snapshot()
                .fx
                .get(scope)
                .map_or(0.0, |slot| match slot.config {
                    FxConfig::None => 0.0,
                    FxConfig::LowPass { cutoff_hz, .. } => cutoff_hz,
                })
        })
    }
    #[no_mangle]
    pub extern "C" fn record(track_id: usize) {
        with_engine(|engine| engine.record(track_id))
    }
    #[no_mangle]
    pub extern "C" fn play(track_id: usize) {
        with_engine(|engine| engine.play(track_id))
    }
    #[no_mangle]
    pub extern "C" fn stop_track(track_id: usize) {
        with_engine(|engine| engine.stop_track(track_id))
    }
    #[no_mangle]
    pub extern "C" fn stop_transport() {
        with_engine(|engine| engine.stop_transport())
    }
    #[no_mangle]
    pub extern "C" fn track_state(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.state as u32)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn loop_length(track_id: usize) -> usize {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.length_samples)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn loop_position(track_id: usize) -> usize {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.position_samples)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn recording_capacity(track_id: usize) -> usize {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.capacity_samples)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn transport_running() -> u32 {
        with_engine(|engine| engine.snapshot().transport_running as u32)
    }
    #[no_mangle]
    pub extern "C" fn transport_position() -> f64 {
        with_engine(|engine| engine.snapshot().transport_position_samples as f64)
    }
    #[no_mangle]
    pub extern "C" fn cycle_length() -> usize {
        with_engine(|engine| engine.snapshot().cycle_length_samples)
    }
    #[no_mangle]
    pub extern "C" fn can_record(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.can_record)
                .unwrap_or_default() as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn can_play(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.can_play)
                .unwrap_or_default() as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn can_stop(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.can_stop)
                .unwrap_or_default() as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn captured_samples(track_id: usize) -> usize {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.captured_samples)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn capture_limit(track_id: usize) -> usize {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.capture_limit_samples)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn set_mode(track_id: usize, mode: u32) {
        let mode = match mode {
            0 => PlaybackMode::Loop,
            1 => PlaybackMode::OneShot,
            _ => return,
        };
        with_engine(|engine| engine.set_mode(track_id, mode));
    }
    #[no_mangle]
    pub extern "C" fn playback_mode(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.mode as u32)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn can_set_mode(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.can_set_mode as u32)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn can_set_loop(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.can_set_loop as u32)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn set_track_gain(track_id: usize, gain: f32) {
        with_engine(|engine| engine.set_track_gain(track_id, gain));
    }
    #[no_mangle]
    pub extern "C" fn set_track_mute(track_id: usize, muted: u32) {
        with_engine(|engine| engine.set_track_mute(track_id, muted != 0));
    }
    #[no_mangle]
    pub extern "C" fn set_master_gain(gain: f32) {
        with_engine(|engine| engine.set_master_gain(gain));
    }
    #[no_mangle]
    pub extern "C" fn master_gain() -> f32 {
        with_engine(|engine| engine.snapshot().master_gain)
    }
    #[no_mangle]
    pub extern "C" fn track_gain(track_id: usize) -> f32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.gain)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn track_muted(track_id: usize) -> u32 {
        with_engine(|engine| {
            engine
                .snapshot()
                .tracks
                .get(track_id)
                .map(|track| track.muted as u32)
                .unwrap_or_default()
        })
    }
    #[no_mangle]
    pub extern "C" fn clear(track_id: usize) {
        with_engine(|engine| engine.clear(track_id));
    }
    #[no_mangle]
    pub extern "C" fn reset() {
        with_engine(|engine| engine.reset());
    }
    #[no_mangle]
    pub extern "C" fn interrupt() {
        with_engine(|engine| engine.interrupt());
    }
    #[no_mangle]
    pub extern "C" fn input_ptr() -> *mut f32 {
        core::ptr::addr_of_mut!(INPUT).cast()
    }
    #[no_mangle]
    pub extern "C" fn command_revision() -> u32 {
        with_engine(|e| e.command_revision())
    }
    #[no_mangle]
    pub extern "C" fn import_begin(
        revision: u32,
        cycle: usize,
        master: f32,
        length0: usize,
        mode0: u32,
        gain0: f32,
        mute0: u32,
        length1: usize,
        mode1: u32,
        gain1: f32,
        mute1: u32,
    ) -> u32 {
        if mode0 > 1 || mode1 > 1 || mute0 > 1 || mute1 > 1 {
            return 0;
        }
        with_engine(|e| {
            e.begin_import(
                ImportMetadata {
                    fx: e.snapshot().fx.map(|slot| slot.config),
                    cycle_length: cycle,
                    master_gain: master,
                    tracks: [
                        ImportTrack {
                            length: length0,
                            mode: if mode0 == 0 {
                                PlaybackMode::Loop
                            } else {
                                PlaybackMode::OneShot
                            },
                            gain: gain0,
                            muted: mute0 != 0,
                        },
                        ImportTrack {
                            length: length1,
                            mode: if mode1 == 0 {
                                PlaybackMode::Loop
                            } else {
                                PlaybackMode::OneShot
                            },
                            gain: gain1,
                            muted: mute1 != 0,
                        },
                    ],
                },
                revision,
            ) as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn import_fx(scope: usize, kind: u32, cutoff: f64, bypassed: u32) -> u32 {
        let config = match (kind, bypassed) {
            (0, 0) if cutoff == 0.0 => FxConfig::None,
            (1, 0..=1) => FxConfig::LowPass {
                cutoff_hz: cutoff,
                bypassed: bypassed != 0,
            },
            _ => return 0,
        };
        with_engine(|e| {
            if scope >= 4 || !e.fx[scope].valid(config) {
                return 0;
            }
            let Some((metadata, revision, _)) = &mut e.import else {
                return 0;
            };
            if *revision != e.command_revision {
                return 0;
            }
            metadata.fx[scope] = config;
            1
        })
    }
    #[no_mangle]
    pub extern "C" fn import_write(id: usize, offset: usize, frames: usize) -> u32 {
        if frames > CAPACITY {
            return 0;
        }
        // SAFETY: fixed input buffer and a single serialized worklet owner.
        with_engine(|e| unsafe {
            e.write_import(id, offset, core::slice::from_raw_parts(input_ptr(), frames)) as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn import_commit() -> u32 {
        with_engine(|e| e.commit_import() as u32)
    }
    #[no_mangle]
    pub extern "C" fn import_cancel() {
        with_engine(|e| e.cancel_import());
    }
    #[no_mangle]
    pub extern "C" fn output_ptr() -> *mut f32 {
        core::ptr::addr_of_mut!(OUTPUT).cast()
    }
    #[no_mangle]
    pub extern "C" fn capacity() -> usize {
        CAPACITY
    }
    #[no_mangle]
    pub extern "C" fn recording_revision(track_id: usize) -> u32 {
        with_engine(|engine| engine.recording_revision(track_id))
    }
    #[no_mangle]
    pub extern "C" fn checkpoint_begin() -> u32 {
        with_engine(|engine| engine.begin_checkpoint().is_some() as u32)
    }
    #[no_mangle]
    pub extern "C" fn checkpoint_cancel() {
        with_engine(|engine| engine.cancel_checkpoint());
    }
    #[no_mangle]
    pub extern "C" fn checkpoint_length(id: usize) -> usize {
        with_engine(|engine| {
            engine
                .checkpoint_metadata()
                .and_then(|m| m.tracks.get(id).map(|t| t.length))
                .unwrap_or(0)
        })
    }
    #[no_mangle]
    pub extern "C" fn checkpoint_cycle() -> usize {
        with_engine(|engine| engine.checkpoint_metadata().map_or(0, |m| m.cycle_length))
    }
    #[no_mangle]
    pub extern "C" fn checkpoint_active() -> u32 {
        with_engine(|engine| engine.checkpoint_metadata().is_some() as u32)
    }
    #[no_mangle]
    pub extern "C" fn read_checkpoint(id: usize, offset: usize, frames: usize) -> u32 {
        if frames > CAPACITY {
            return 0;
        }
        // SAFETY: fixed transfer buffer and serialized worklet host.
        with_engine(|engine| unsafe {
            engine.read_checkpoint(
                id,
                offset,
                core::slice::from_raw_parts_mut(output_ptr(), frames),
            ) as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn read_recording(
        track_id: usize,
        revision: u32,
        offset: usize,
        frames: usize,
    ) -> u32 {
        if frames > CAPACITY {
            return 0;
        }
        // SAFETY: bounded fixed output buffer, used only by the serialized host.
        with_engine(|engine| unsafe {
            engine.read_recording(
                track_id,
                revision,
                offset,
                core::slice::from_raw_parts_mut(output_ptr(), frames),
            ) as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn set_monitoring(enabled: u32) {
        with_engine(|engine| engine.set_monitoring(enabled != 0));
    }
    #[no_mangle]
    pub extern "C" fn monitoring() -> u32 {
        with_engine(|engine| engine.monitoring() as u32)
    }
    #[no_mangle]
    pub extern "C" fn process(frames: usize) -> usize {
        if frames > CAPACITY {
            return 0;
        }
        // SAFETY: disjoint static buffers; bounded length; one serialized host
        // owner which must not access buffers during processing.
        let failed = with_engine(|engine| unsafe {
            engine.process(
                core::slice::from_raw_parts(input_ptr(), frames),
                core::slice::from_raw_parts_mut(output_ptr(), frames),
            );
            engine.audio_failed
        });
        if failed {
            0
        } else {
            frames
        }
    }
}
