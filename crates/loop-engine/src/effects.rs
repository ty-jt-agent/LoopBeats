//! Fixed-size, mono first-filter state. No browser or persistence ownership.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FxConfig {
    None,
    LowPass { cutoff_hz: f64, bypassed: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum FxError {
    Invalid = 1,
    Busy = 2,
    Unavailable = 3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FxSnapshot {
    pub config: FxConfig,
    pub transitioning: bool,
    pub removing: bool,
}

#[derive(Clone, Copy)]
struct Ramp {
    current: f64,
    target: f64,
    remaining: u32,
}
impl Ramp {
    fn new(value: f64) -> Self {
        Self {
            current: value,
            target: value,
            remaining: 0,
        }
    }
    fn retarget(&mut self, target: f64, samples: u32) {
        self.target = target;
        self.remaining = if target == self.current { 0 } else { samples };
    }
    fn advance(&mut self) -> f64 {
        if self.remaining > 0 {
            self.current += (self.target - self.current) / f64::from(self.remaining);
            self.remaining -= 1;
            if self.remaining == 0 {
                self.current = self.target;
            }
        }
        self.current
    }
    fn finish(&mut self) {
        self.current = self.target;
        self.remaining = 0;
    }
}

pub(crate) struct FxSlot {
    config: FxConfig,
    sample_rate: u32,
    removing: bool,
    cutoff: Ramp,
    wet: Ramp,
    coefficients: [f64; 5],
    history: [f64; 2],
}
impl FxSlot {
    pub fn new(sample_rate: u32) -> Self {
        let maximum = Self::maximum(sample_rate);
        let mut slot = Self {
            config: FxConfig::LowPass {
                cutoff_hz: maximum,
                bypassed: true,
            },
            sample_rate,
            removing: false,
            cutoff: Ramp::new(maximum.ln()),
            wet: Ramp::new(0.0),
            coefficients: [0.0; 5],
            history: [0.0; 2],
        };
        slot.update_coefficients();
        slot
    }
    pub fn maximum(sample_rate: u32) -> f64 {
        20_000.0_f64.min(f64::from(sample_rate) * 0.45)
    }
    pub fn valid(&self, config: FxConfig) -> bool {
        match config {
            FxConfig::None => true,
            FxConfig::LowPass { cutoff_hz, .. } => {
                cutoff_hz.is_finite()
                    && (20.0..=Self::maximum(self.sample_rate)).contains(&cutoff_hz)
            }
        }
    }
    /// Restoration installs accepted targets directly with no audible edit ramp.
    pub fn restore(&mut self, config: FxConfig) {
        debug_assert!(self.valid(config));
        *self = Self::new(self.sample_rate);
        self.set(config).expect("validated restored FX");
        self.clear_history();
    }
    pub fn snapshot(&self) -> FxSnapshot {
        FxSnapshot {
            config: self.config,
            transitioning: self.cutoff.remaining > 0 || self.wet.remaining > 0,
            removing: self.removing,
        }
    }
    pub fn set(&mut self, config: FxConfig) -> Result<(), FxError> {
        if !self.valid(config) {
            return Err(FxError::Invalid);
        }
        if self.removing {
            return Err(FxError::Busy);
        }
        let samples = (f64::from(self.sample_rate) * 0.010).ceil() as u32;
        match config {
            FxConfig::None => {
                if self.config != FxConfig::None {
                    self.removing = true;
                    self.wet.retarget(0.0, samples);
                    // Removal is structural even when already dry: keep a bounded
                    // retirement boundary before accepting a new filter.
                    self.wet.remaining = samples;
                }
            }
            FxConfig::LowPass {
                cutoff_hz,
                bypassed,
            } => {
                if self.config == FxConfig::None {
                    // Re-add is always the default bypassed filter, not a way to
                    // resurrect stale history or silently install a wet effect.
                    let default = Self::maximum(self.sample_rate);
                    if cutoff_hz != default || !bypassed {
                        return Err(FxError::Invalid);
                    }
                    *self = Self::new(self.sample_rate);
                } else {
                    if let FxConfig::LowPass {
                        cutoff_hz: previous,
                        bypassed: was_bypassed,
                    } = self.config
                    {
                        if cutoff_hz != previous {
                            self.cutoff.retarget(cutoff_hz.ln(), samples);
                        }
                        if bypassed != was_bypassed {
                            self.wet.retarget(if bypassed { 0.0 } else { 1.0 }, samples);
                        }
                    }
                }
            }
        }
        self.config = config;
        Ok(())
    }
    pub fn clear_history(&mut self) {
        self.history = [0.0; 2];
        self.cutoff.finish();
        self.wet.finish();
        self.removing = false;
        self.update_coefficients();
    }
    pub fn reset(&mut self) {
        *self = Self::new(self.sample_rate);
    }
    fn update_coefficients(&mut self) {
        // Cookbook biquad computed from the instantaneous log-frequency ramp;
        // never interpolate arbitrary coefficient sets across poles.
        let omega = std::f64::consts::TAU * self.cutoff.current.exp() / f64::from(self.sample_rate);
        let cosine = omega.cos();
        let alpha = omega.sin() / std::f64::consts::SQRT_2;
        let a0 = 1.0 + alpha;
        let b0 = (1.0 - cosine) / (2.0 * a0);
        self.coefficients = [b0, 2.0 * b0, b0, -2.0 * cosine / a0, (1.0 - alpha) / a0];
    }
    pub fn process(&mut self, source: f32) -> Option<f32> {
        if !source.is_finite() {
            return None;
        }
        if self.config == FxConfig::None && !self.removing {
            return Some(source);
        }
        if self.cutoff.remaining > 0 {
            self.cutoff.advance();
            self.update_coefficients();
        }
        let [b0, b1, b2, a1, a2] = self.coefficients;
        let dry = f64::from(source);
        let filtered = b0 * dry + self.history[0];
        self.history = [
            b1 * dry - a1 * filtered + self.history[1],
            b2 * dry - a2 * filtered,
        ];
        let wet = self.wet.advance();
        let output = if wet == 0.0 {
            source
        } else {
            (dry + (filtered - dry) * wet) as f32
        };
        if !output.is_finite()
            || !filtered.is_finite()
            || self.history.iter().any(|s| !s.is_finite())
        {
            return None;
        }
        if self.removing && self.wet.remaining == 0 {
            self.clear_history();
        }
        Some(output)
    }
}
