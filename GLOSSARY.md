# Loopstation domain
A session combines recorded audio tracks with a shared looping timeline and independent one-shot playback.

## Language

**Session**: The current loopstation workspace containing tracks and a transport.

**Track**: One audio channel holding a recording and its playback mode.

**Recording**: Captured audio held by a track.
_Avoid_: File, saved session (when referring to temporary captured audio).

**Loop**: A recording played repeatedly in alignment with the shared cycle.

**Loop mode**: Playback that repeats and follows the shared cycle position.
_Avoid_: Default mode, from-beginning mode.

**One-shot**: Playback of a recording from its beginning once, ending automatically.
_Avoid_: Resume, synchronized loop.

**Transport**: The shared timeline governing Loop-mode synchronization.

**Shared cycle**: The repeating time span used by all Loop-mode tracks.

**Shared cycle length**: The duration established for the session's repeating cycle.
_Avoid_: Tempo, BPM (these describe musical rate, not cycle duration).

**Cycle position**: The current location within the repeating shared cycle.

**Transport position**: The current location on the shared timeline.

**Loop length**: The duration of one complete repeating recording.

**Cycle**: One full traversal of a repeating loop.

**Loop boundary**: The point between successive loop cycles.

**Record**: Capture incoming audio into an empty track.

**Overdub**: Add captured input to an existing Loop recording without changing its duration.

**Empty**: A track with no recording.

**Recording state**: A track currently capturing its initial recording.

**Playing**: A track whose recording is advancing for playback, subject to mute.

**Overdubbing**: A Loop track playing and adding incoming audio to its recording.

**Stopped**: A track with retained audio that is neither playing nor capturing.

**Muted**: A track whose playback contribution is silent while its position continues advancing.
_Avoid_: Stopped, paused.

**Track stop**: End one track's playback or capture while retaining its captured audio.

**Transport stop**: Stop session playback and return the shared timeline to its beginning.

**Clear**: Remove one track's recording.

**Session reset**: Clear every track and reset the shared cycle and transport.

**Input monitoring**: Listening to live input after Input FX through the application's output. Turning monitoring off does not disable capture or Input FX.

**Input FX**: Shared effects applied to incoming audio before capture. Their sound becomes part of newly recorded audio and overdub additions.

**Track FX**: Effects applied to an individual track's playback without changing its stored recording.

**Master FX**: Effects applied to the mix of track playback and monitored input without changing stored recordings.

**Baked effect**: An effect whose sound is part of a recording and remains when that effect is later bypassed.

**Low-pass filter**: An effect that reduces high-frequency content above its cutoff while retaining lower-frequency content.

**Cutoff**: The frequency around which a low-pass filter begins attenuating higher-frequency sound, expressed in hertz.

**FX bypass**: Hearing an effect's dry input instead of its processed output while retaining the effect configuration. Bypass does not undo effects already baked into a recording.

**FX scope**: The part of a session affected by an effect: incoming input, one track's playback, or the final mix.

**FX slot**: A place within an FX scope holding one effect or no effect.

**FX configuration**: The effect selection, bypass state and sound parameters belonging to a session's FX slots.

**FX history**: The transient sound state accumulated by an effect as it processes audio, distinct from its configuration and stored recordings.

**FX tail**: Sound an effect continues producing from its history after its source stops contributing new audio.

**Playback mode**: A track's selection of Loop or One-shot playback.

**Quantization**: Scheduling an operation at an appropriate musical boundary; a later feature.

**Armed**: Waiting for a scheduled boundary before an operation starts; later scheduling vocabulary.

**Track gain**: A linear multiplier on one track's playback after Track FX, including its effect tails, independent of captured audio and mute.

**Master gain**: A linear multiplier on the final output after Master FX, including monitored input and effect tails, before clipping protection.

**Session file**: A portable saved representation of a session, containing completed track recordings and the session settings needed to continue working with them.
_Avoid_: Project file, saved settings

**Recovery snapshot**: An automatically maintained browser-stored representation of the current session used to recover work after an unexpected shutdown or crash.
_Avoid_: Autosave file, session file

**Audio host**: The platform-specific part of LoopBeats that connects audio devices to the loop engine and manages audio-session lifecycle.

**Audio application contract**: The platform-neutral commands and acknowledged session state used by the interface to control and observe an audio host.

**Capture discontinuity**: Confirmed loss, dropping, or replacement with synthetic silence of captured samples before they reach the loop engine.

**Audio interruption**: A host event that stops valid session processing, disables monitoring and resets transport while retaining completed recordings and captured overdub additions; unfinished initial recording is discarded.

**Session export**: The operation that packages a session file for download outside the browser.

**Session import**: The operation that validates a session file and replaces the current session with its contents.
