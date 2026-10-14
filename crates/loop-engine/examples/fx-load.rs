use loop_engine::{FxConfig, ImportMetadata, ImportTrack, LoopEngine, PlaybackMode};
use std::time::{Duration, Instant};

const BLOCK: usize = 128;

fn percentile(sorted: &[u128], percent: usize) -> u128 {
    sorted[((sorted.len() - 1) * percent).div_ceil(100)]
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let seconds = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(600u32);
    let rates = [8_000u32, 44_100, 48_000, 192_000];
    println!(
        "Synthetic native engine load; seconds={seconds}; block={BLOCK}; arch={}",
        std::env::consts::ARCH
    );
    println!("No browser host, audio device, checkpoint serialization/storage, busy UI, or physical listening is measured.");

    for rate in rates {
        let capacity = rate as usize * 60;
        for scenario in [
            "baseline",
            "four-active",
            "four-warm-bypassed",
            "four-rapid-bypass-edits",
        ] {
            let mut engine = LoopEngine::with_capacity_and_sample_rate(capacity, rate);
            let configured = scenario != "baseline";
            let bypassed = scenario == "four-warm-bypassed";
            let toggle_bypass = scenario == "four-rapid-bypass-edits";
            let cutoff = 4_000.0f64.min(f64::from(rate) * 0.45).max(20.0);
            let fx = if configured {
                FxConfig::LowPass {
                    cutoff_hz: cutoff,
                    bypassed,
                }
            } else {
                FxConfig::None
            };
            let track = ImportTrack {
                length: capacity,
                mode: PlaybackMode::Loop,
                gain: 1.0,
                muted: false,
            };
            let metadata = ImportMetadata {
                fx: [fx; 4],
                cycle_length: capacity,
                master_gain: 1.0,
                tracks: [track; 2],
            };
            let revision = engine.command_revision();
            assert!(engine.begin_import(metadata, revision));
            let samples = vec![0.125f32; BLOCK];
            for id in 0..2 {
                for offset in (0..capacity).step_by(BLOCK) {
                    let count = BLOCK.min(capacity - offset);
                    assert!(engine.write_import(id, offset, &samples[..count]));
                }
            }
            assert!(engine.commit_import());
            engine.set_monitoring(true);
            engine.play(0);
            engine.play(1);

            let input = vec![0.03125f32; BLOCK];
            let mut output = vec![0.0f32; BLOCK];
            let iterations = (u64::from(rate) * u64::from(seconds)).div_ceil(BLOCK as u64);
            let mut times = Vec::with_capacity((iterations / 100).max(1) as usize);
            let start = Instant::now();
            let mut callbacks = 0u64;
            let mut misses = 0u64;
            let overdub_interval = (u64::from(rate) * 5 / BLOCK as u64).max(2);
            let mut edit_count = 0u64;
            for i in 0..iterations {
                let callback_start = Instant::now();
                engine.process(&input, &mut output);
                let elapsed = callback_start.elapsed().as_nanos();
                std::hint::black_box(&output);
                callbacks += 1;
                if i % 100 == 0 {
                    times.push(elapsed);
                }
                if elapsed > Duration::from_secs_f64(BLOCK as f64 / f64::from(rate)).as_nanos() {
                    misses += 1;
                }
                if configured && i % 32 == 0 {
                    let snapshot = engine.snapshot();
                    let target_bypassed = if toggle_bypass {
                        edit_count % 2 == 1
                    } else {
                        bypassed
                    };
                    edit_count += 1;
                    for scope in 0..4 {
                        let maximum = 20_000.0f64.min(f64::from(rate) * 0.45);
                        let cutoff = 20.0 + (i % 1_000) as f64 / 999.0 * (maximum - 20.0);
                        let config = FxConfig::LowPass {
                            cutoff_hz: cutoff,
                            bypassed: target_bypassed,
                        };
                        match scope {
                            0 => {
                                let _ = engine.set_input_fx(config);
                            }
                            1 | 2 => {
                                let _ = engine.set_track_fx(scope - 1, config);
                            }
                            _ => {
                                let _ = engine.set_master_fx(config);
                            }
                        }
                    }
                    std::hint::black_box(snapshot);
                }
                if i % overdub_interval < 2 {
                    engine.record(0);
                }
                if i % (overdub_interval * 12) == 0 && engine.begin_checkpoint().is_some() {
                    engine.cancel_checkpoint();
                }
            }
            let elapsed = start.elapsed();
            times.sort_unstable();
            println!("rate={rate} scenario={scenario} capacity_samples={capacity} two_track_sample_bytes={}", capacity * 2 * std::mem::size_of::<f32>());
            println!("  callbacks={callbacks} wall_seconds={:.3} p50_ns={} p95_ns={} p99_ns={} max_sampled_ns={} deadline_misses_observed={misses}", elapsed.as_secs_f64(), percentile(&times, 50), percentile(&times, 95), percentile(&times, 99), times.last().copied().unwrap_or_default());
        }
    }
}
