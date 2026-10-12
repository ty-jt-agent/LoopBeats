use loop_engine::FxConfig;
use loop_engine::LoopEngine;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static MEASURING: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}
struct Allocator;
// SAFETY: all allocations and deallocations delegate unchanged to System.
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if MEASURING.with(Cell::get) {
            ALLOCATIONS.with(|count| count.set(count.get() + 1));
        }
        // SAFETY: same caller-provided layout.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: same caller-provided allocation and layout.
        unsafe { System.dealloc(pointer, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

#[test]
fn checkpoint_begin_copy_on_write_reads_and_cancel_never_allocate() {
    let mut engine = LoopEngine::with_capacity(4096);
    let input = [0.25; 2048];
    let mut output = [0.0; 2048];
    engine.record(0);
    engine.process(&input, &mut output);
    engine.record(0);
    engine.record(0);
    ALLOCATIONS.with(|count| count.set(0));
    MEASURING.with(|active| active.set(true));
    let began = engine.begin_checkpoint().is_some();
    engine.process(&input, &mut output);
    let read = engine.read_checkpoint(0, 0, &mut output);
    engine.cancel_checkpoint();
    MEASURING.with(|active| active.set(false));
    assert!(began && read);
    assert_eq!(ALLOCATIONS.with(Cell::get), 0);
    assert!(output.iter().all(|sample| *sample == 0.25));
}

#[test]
fn input_fx_commands_capture_ramps_and_retirement_never_allocate() {
    let mut engine = LoopEngine::with_capacity(4096);
    let mut output = [0.0; 512];
    ALLOCATIONS.with(|count| count.set(0));
    MEASURING.with(|active| active.set(true));
    let enabled = engine
        .set_input_fx(FxConfig::LowPass {
            cutoff_hz: 1000.0,
            bypassed: false,
        })
        .is_ok();
    engine.record(0);
    engine.process(&[0.25; 512], &mut output);
    engine.record(0);
    engine.record(0);
    engine.process(&[0.125; 512], &mut output);
    let removed = engine.set_input_fx(FxConfig::None).is_ok();
    engine.process(&[], &mut output);
    engine.stop_transport();
    engine.reset();
    MEASURING.with(|active| active.set(false));
    assert!(enabled && removed);
    assert_eq!(ALLOCATIONS.with(Cell::get), 0);
}

#[test]
fn track_fx_playback_edits_mute_retirement_and_lifecycle_never_allocate() {
    let mut engine = LoopEngine::with_capacity(1024);
    engine.record(0);
    engine.process(&[0.25; 512], &mut [0.0; 512]);
    engine.record(0);
    let mut output = [0.0; 512];
    ALLOCATIONS.with(|count| count.set(0));
    MEASURING.with(|active| active.set(true));
    let accepted = engine
        .set_track_fx(
            0,
            FxConfig::LowPass {
                cutoff_hz: 1000.0,
                bypassed: false,
            },
        )
        .is_ok();
    engine.set_track_mute(0, true);
    engine.process(&[], &mut output);
    let removed = engine.set_track_fx(0, FxConfig::None).is_ok();
    engine.stop_track(0);
    engine.clear(0);
    engine.process(&[], &mut output);
    engine.reset();
    MEASURING.with(|active| active.set(false));
    assert!(accepted && removed);
    assert_eq!(ALLOCATIONS.with(Cell::get), 0);
}
