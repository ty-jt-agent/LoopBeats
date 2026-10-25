use native_audio_host::{AudioCommand, HostEvent, Processor};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingAllocator;
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        System.realloc(pointer, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: CountingAllocator = CountingAllocator;

#[test]
fn render_processing_with_a_queued_command_does_not_allocate() {
    let (mut adapter, mut processor) = Processor::controlled(32, 48_000);
    adapter.submit(AudioCommand::SetMonitoring(true)).unwrap();
    adapter.flush(8);
    let input = [0.25; 32];
    let mut output = [0.0; 32];
    let before = ALLOCATIONS.load(Ordering::SeqCst);
    processor.process_block(&input, &mut output, HostEvent::None);
    let after = ALLOCATIONS.load(Ordering::SeqCst);
    assert_eq!(after, before);
    assert_eq!(output, input);
}
