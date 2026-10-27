use loop_engine::{FxConfig, ImportMetadata, ImportTrack, PlaybackMode, TrackState};
use native_audio_host::{HostEvent, Processor};
use std::sync::mpsc;

fn through_render_block<T: Send + 'static>(
    processor: &mut Processor,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || sender.send(operation()).unwrap());
    let mut output = [0.0; 64];
    loop {
        if let Ok(result) = receiver.try_recv() {
            return result;
        }
        processor.process_block(&[], &mut output, HostEvent::None);
        processor.service_session_transfer();
        std::thread::yield_now();
    }
}

#[test]
fn native_session_transfer_stages_and_exports_exact_samples_in_bounded_chunks() {
    let (commands, mut processor) = Processor::controlled(64, 48_000);
    let transfer = commands.session_transfer();
    let metadata = ImportMetadata {
        fx: [FxConfig::None; 4],
        cycle_length: 0,
        master_gain: 0.75,
        tracks: [
            ImportTrack {
                length: 3,
                mode: PlaybackMode::OneShot,
                gain: 0.5,
                muted: true,
            },
            ImportTrack {
                length: 0,
                mode: PlaybackMode::Loop,
                gain: 1.0,
                muted: false,
            },
        ],
    };

    let begin = transfer.clone();
    through_render_block(&mut processor, move || begin.begin_import(metadata)).unwrap();
    let write = transfer.clone();
    through_render_block(&mut processor, move || {
        write.write_import_chunk(0, 0, &[0.25, -0.5, 1.25])
    })
    .unwrap();
    let commit = transfer.clone();
    through_render_block(&mut processor, move || commit.commit_import()).unwrap();

    let snapshot = processor.snapshot();
    assert_eq!(snapshot.tracks[0].state, TrackState::Stopped);
    assert_eq!(snapshot.tracks[0].length_samples, 3);
    assert_eq!(snapshot.tracks[1].state, TrackState::Empty);

    let export = transfer.clone();
    let (rate, exported, revisions) =
        through_render_block(&mut processor, move || export.begin_export()).unwrap();
    assert_eq!(rate, 48_000);
    assert_eq!(exported.master_gain, 0.75);
    assert_eq!(exported.tracks[0].mode, PlaybackMode::OneShot);
    let read = transfer.clone();
    let samples = through_render_block(&mut processor, move || {
        read.read_export_chunk(0, revisions[0], 0, 3)
    })
    .unwrap();
    assert_eq!(samples, [0.25, -0.5, 1.25]);
}

#[test]
fn incomplete_import_is_rejected_and_cancel_preserves_the_live_session() {
    let (commands, mut processor) = Processor::controlled(64, 48_000);
    let transfer = commands.session_transfer();
    let metadata = ImportMetadata {
        fx: [FxConfig::None; 4],
        cycle_length: 0,
        master_gain: 1.0,
        tracks: [
            ImportTrack {
                length: 2,
                mode: PlaybackMode::OneShot,
                gain: 1.0,
                muted: false,
            },
            ImportTrack {
                length: 0,
                mode: PlaybackMode::Loop,
                gain: 1.0,
                muted: false,
            },
        ],
    };
    let begin = transfer.clone();
    through_render_block(&mut processor, move || begin.begin_import(metadata)).unwrap();
    let commit = transfer.clone();
    assert!(through_render_block(&mut processor, move || commit.commit_import()).is_err());
    let cancel = transfer.clone();
    through_render_block(&mut processor, move || cancel.cancel_import()).unwrap();
    assert_eq!(processor.snapshot().tracks[0].state, TrackState::Empty);
}
