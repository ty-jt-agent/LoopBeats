// Numeric states match Rust TrackState's repr(u32) ABI.
const TRACK_STATE = {
  Empty: 0,
  Recording: 1,
  Playing: 2,
  Stopped: 3,
  Overdubbing: 4,
};
const TRACK_STATE_NAMES = Object.keys(TRACK_STATE);

// Real-time callback uses fixed views and counters. Messages allocate outside process().
class LoopProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new WebAssembly.Instance(
      options.processorOptions.module,
    ).exports;
    if (this.engine.initialize(sampleRate) !== 1)
      throw new Error('Unsupported audio sample rate');
    this.input = new Float32Array(
      this.engine.memory.buffer,
      this.engine.input_ptr(),
      this.engine.capacity(),
    );
    this.output = new Float32Array(
      this.engine.memory.buffer,
      this.engine.output_ptr(),
      this.engine.capacity(),
    );
    this.memory = this.engine.memory.buffer;
    this.frames = 0;
    this.blockSequence = 0;
    this.generation = options.processorOptions.generation;
    this.commands = [];
    this.inputLevel = 0;
    this.outputLevel = 0;
    this.failed = false;
    this.exportSession = null;
    this.importSession = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'set-generation') {
        this.generation = data.generation;
        return;
      }
      if (data.type === 'application-command') {
        const { commandId, generation, command } = data;
        if (generation !== this.generation) {
          this.port.postMessage({ commandId, generation, status: 'stale' });
          return;
        }
        // AudioClient bounds outstanding commands to this same capacity.
        if (this.commands.length >= 64) {
          this.port.postMessage({
            commandId,
            generation,
            status: 'failed',
            error: 'Audio command capacity exceeded.',
          });
          return;
        }
        this.commands.push({ commandId, generation, command });
        return;
      }
      if (data.type === 'set-playback-fx') {
        const config = data.config;
        const valid =
          config &&
          typeof config === 'object' &&
          ((config.type === 'None' && Object.keys(config).length === 1) ||
            (config.type === 'LowPass' &&
              Object.keys(config).length === 3 &&
              Number.isFinite(config.cutoffHz) &&
              typeof config.bypassed === 'boolean'));
        const args = valid
          ? [
              config.type === 'None' ? 0 : 1,
              config.type === 'None' ? 0 : config.cutoffHz,
              config.type === 'None' ? 0 : Number(config.bypassed),
            ]
          : [];
        const supportedScope =
          Number.isInteger(data.scope) && data.scope >= 1 && data.scope <= 3;
        const result = this.failed
          ? 3
          : !valid || !supportedScope
            ? 1
            : data.scope === 3
              ? (this.engine.set_master_fx?.(...args) ?? 1)
              : (this.engine.set_track_fx?.(data.scope - 1, ...args) ?? 1);
        const error = [
          '',
          'Invalid FX configuration. The previous setting is retained.',
          'FX is being removed. Try again after the transition.',
          'Audio processing is unavailable.',
        ][result];
        this.publishSnapshot();
        this.port.postMessage({
          type: 'playback-fx-reply',
          scope: data.scope,
          requestId: data.requestId,
          error: error || undefined,
        });
        return;
      }
      if (data.type === 'set-input-fx') {
        let error;
        const config = data.config;
        const valid =
          config &&
          typeof config === 'object' &&
          ((config.type === 'None' && Object.keys(config).length === 1) ||
            (config.type === 'LowPass' &&
              Object.keys(config).length === 3 &&
              Number.isFinite(config.cutoffHz) &&
              typeof config.bypassed === 'boolean'));
        const result = this.failed
          ? 3
          : !valid
            ? 1
            : this.engine.set_input_fx(
                config.type === 'None' ? 0 : 1,
                config.type === 'None' ? 0 : config.cutoffHz,
                config.type === 'None' ? 0 : Number(config.bypassed),
              );
        if (result)
          error = [
            '',
            'Invalid Input FX configuration. The previous setting is retained.',
            'Input FX is being removed. Try again after the transition.',
            'Audio processing is unavailable.',
          ][result];
        this.publishSnapshot();
        this.port.postMessage({
          type: 'input-fx-reply',
          requestId: data.requestId,
          error,
        });
        return;
      }
      const checkpoint = data.type.startsWith('checkpoint-');
      if (checkpoint)
        data = { ...data, type: data.type.replace('checkpoint-', 'export-') };
      if (data.type.startsWith('import-')) {
        const reply = { type: 'import-reply', requestId: data.requestId };
        try {
          if (data.type === 'import-cancel') {
            if (this.importSession?.token === data.token) {
              this.importSession = null;
              this.engine.import_cancel();
            }
            return;
          }
          if (this.failed) throw new Error('Audio processor is unavailable.');
          if (data.type === 'import-begin') {
            if (
              this.exportSession ||
              [0, 1].some((id) => [1, 4].includes(this.engine.track_state(id)))
            )
              throw new Error(
                'Finish recording and other session operations before importing.',
              );
            if (
              this.importSession &&
              data.requestId <= this.importSession.token
            )
              throw new Error('Stale import operation.');
            this.engine.import_cancel();
            this.importSession = {
              token: data.requestId,
              revision: this.engine.command_revision(),
            };
            reply.hasRecordings = [0, 1].some(
              (id) => this.engine.loop_length(id) > 0,
            );
          } else {
            const session = this.importSession;
            if (
              !session ||
              session.token !== data.token ||
              session.revision !== this.engine.command_revision()
            )
              throw new Error('Session changed during import. Try again.');
            if (data.type === 'import-configure') {
              const m = data.manifest;
              if (
                m.sampleRate !== sampleRate ||
                !this.engine.import_begin(
                  session.revision,
                  m.cycleLengthSamples,
                  m.masterGain,
                  ...m.tracks.flatMap((t) => [
                    t.lengthSamples,
                    t.mode === 'OneShot' ? 1 : 0,
                    t.gain,
                    Number(t.muted),
                  ]),
                )
              )
                throw new Error('Session cannot be staged.');
              for (const [scope, config] of [
                m.inputFx,
                m.tracks[0].fx,
                m.tracks[1].fx,
                m.masterFx,
              ].entries()) {
                const restored =
                  m.version === 1
                    ? {
                        type: 'LowPass',
                        cutoffHz: Math.min(20000, sampleRate * 0.45),
                        bypassed: true,
                      }
                    : config;
                if (
                  !restored ||
                  !this.engine.import_fx(
                    scope,
                    restored.type === 'None' ? 0 : 1,
                    restored.type === 'None' ? 0 : restored.cutoffHz,
                    restored.type === 'None' ? 0 : Number(restored.bypassed),
                  )
                )
                  throw new Error('Invalid staged FX configuration.');
              }
            } else if (data.type === 'import-write') {
              if (
                !(data.samples instanceof Float32Array) ||
                data.samples.length < 1 ||
                data.samples.length > 2048 ||
                !Number.isInteger(data.offset) ||
                data.offset < 0 ||
                ![0, 1].includes(data.trackId)
              )
                throw new Error('Invalid import transfer.');
              this.input.set(data.samples);
              if (
                !this.engine.import_write(
                  data.trackId,
                  data.offset,
                  data.samples.length,
                )
              )
                throw new Error(
                  'Import staging failed. The current session is unchanged.',
                );
            } else if (data.type === 'import-commit') {
              if (!this.engine.import_commit())
                throw new Error('Import is incomplete or stale. Try again.');
              this.importSession = null;
              this.publishSnapshot();
            } else throw new Error('Unsupported import command.');
          }
        } catch (error) {
          reply.error = error.message;
          const owned =
            this.importSession?.token ===
            (data.type === 'import-begin' ? data.requestId : data.token);
          if (owned) {
            this.importSession = null;
            this.engine.import_cancel();
          }
        }
        this.port.postMessage(reply);
        return;
      }
      if (
        data.type === 'export-begin' ||
        data.type === 'export-read' ||
        data.type === 'export-finish'
      ) {
        const reply = { type: 'export-reply', requestId: data.requestId };
        let ownsOperation = false;
        try {
          if (this.failed) throw new Error('Audio processor is unavailable.');
          if (data.type === 'export-begin') {
            if (
              this.importSession ||
              (this.exportSession && data.requestId <= this.exportSession.token)
            )
              throw new Error('A session operation is already in progress.');
            // A newer operation supersedes an abandoned transfer even if cancellation
            // could not reach the port. Older tokens cannot take its ownership.
            if (this.exportSession?.checkpoint) this.engine.checkpoint_cancel();
            this.exportSession = null;
            if (
              !checkpoint &&
              [0, 1].some(
                (id) => this.engine.track_state(id) === TRACK_STATE.Overdubbing,
              )
            )
              throw new Error('Finish overdub before exporting.');
            ownsOperation = true;
            if (checkpoint && !this.engine.checkpoint_begin())
              throw new Error(
                'Recovery checkpoint is incompatible or unavailable. Previous snapshot retained.',
              );
            if (checkpoint) reply.checkpointStartedAt = Date.now();
            const tracks = [0, 1].map((id) => {
              const completed = [
                TRACK_STATE.Playing,
                TRACK_STATE.Stopped,
              ].includes(this.engine.track_state(id));
              return {
                id,
                fx: this.fxConfig(id + 1),
                mode: this.engine.playback_mode(id) === 1 ? 'OneShot' : 'Loop',
                gain: this.engine.track_gain(id),
                muted: Boolean(this.engine.track_muted(id)),
                lengthSamples: checkpoint
                  ? this.engine.checkpoint_length(id)
                  : completed
                    ? this.engine.loop_length(id)
                    : 0,
                audioPath: (
                  checkpoint ? this.engine.checkpoint_length(id) > 0 : completed
                )
                  ? `tracks/${id}.wav`
                  : null,
              };
            });
            this.exportSession = {
              token: data.requestId,
              checkpoint,
              deadline: this.frames + sampleRate * 30,
              tracks,
              revisions: [0, 1].map((id) => this.engine.recording_revision(id)),
            };
            reply.manifest = {
              format: 'LoopBeatsSession',
              version: 2,
              inputFx: this.fxConfig(0),
              masterFx: this.fxConfig(3),
              sampleRate,
              cycleLengthSamples: checkpoint
                ? this.engine.checkpoint_cycle()
                : this.engine.cycle_length(),
              masterGain: this.engine.master_gain(),
              tracks,
            };
            if (checkpoint)
              reply.captureKinds = [0, 1].map((id) => {
                const state = this.engine.track_state(id);
                return state === TRACK_STATE.Overdubbing
                  ? 'Overdub'
                  : state !== TRACK_STATE.Recording
                    ? null
                    : this.engine.playback_mode(id) === 1
                      ? 'OneShot'
                      : this.engine.cycle_length() === 0
                        ? 'FirstLoop'
                        : 'JoinedLoop';
              });
          } else {
            const session = this.exportSession;
            ownsOperation = Boolean(
              session &&
              session.token === data.token &&
              session.checkpoint === checkpoint,
            );
            if (
              !session ||
              session.token !== data.token ||
              session.checkpoint !== checkpoint ||
              (checkpoint && !this.engine.checkpoint_active())
            )
              throw new Error('Export was canceled.');
            session.deadline = this.frames + sampleRate * 30;
            for (const track of session.tracks) {
              if (
                !checkpoint &&
                track.audioPath &&
                (this.engine.recording_revision(track.id) !==
                  session.revisions[track.id] ||
                  ![TRACK_STATE.Playing, TRACK_STATE.Stopped].includes(
                    this.engine.track_state(track.id),
                  ))
              )
                throw new Error('Recording changed during export. Try again.');
            }
            if (data.type === 'export-read') {
              const track = session.tracks[data.trackId];
              if (
                !track?.audioPath ||
                !Number.isInteger(data.offset) ||
                data.offset < 0 ||
                !Number.isInteger(data.frames) ||
                data.frames < 1 ||
                data.frames > 2048 ||
                data.offset + data.frames > track.lengthSamples ||
                !(checkpoint
                  ? this.engine.read_checkpoint(
                      data.trackId,
                      data.offset,
                      data.frames,
                    )
                  : this.engine.read_recording(
                      data.trackId,
                      session.revisions[data.trackId],
                      data.offset,
                      data.frames,
                    ))
              )
                throw new Error('Recording is no longer exportable.');
              reply.samples = this.output.slice(0, data.frames);
            } else {
              if (checkpoint) this.engine.checkpoint_cancel();
              this.exportSession = null;
            }
          }
        } catch (error) {
          reply.error = error.message;
          if (ownsOperation) {
            if (checkpoint) this.engine.checkpoint_cancel();
            this.exportSession = null;
          }
        }
        this.port.postMessage(
          reply,
          reply.samples ? [reply.samples.buffer] : [],
        );
        return;
      }
      if (data.type === 'export-cancel') {
        if (
          this.exportSession?.token === data.token &&
          this.exportSession.checkpoint === checkpoint
        ) {
          if (this.exportSession.checkpoint) this.engine.checkpoint_cancel();
          this.exportSession = null;
        }
        return;
      }
      if (data.type === 'monitoring' && !this.failed)
        this.engine.set_monitoring(data.enabled ? 1 : 0);
      if (!this.failed) {
        switch (data.type) {
          case 'set-track-gain':
            if (
              (data.trackId === 0 || data.trackId === 1) &&
              Number.isFinite(data.gain)
            )
              this.engine.set_track_gain(data.trackId, data.gain);
            break;
          case 'set-track-mute':
            if (
              (data.trackId === 0 || data.trackId === 1) &&
              typeof data.muted === 'boolean'
            )
              this.engine.set_track_mute(data.trackId, data.muted ? 1 : 0);
            break;
          case 'set-master-gain':
            if (Number.isFinite(data.gain))
              this.engine.set_master_gain(data.gain);
            break;
          case 'set-mode':
            if (
              (data.trackId === 0 || data.trackId === 1) &&
              (data.mode === 'Loop' || data.mode === 'OneShot')
            )
              this.engine.set_mode(
                data.trackId,
                data.mode === 'OneShot' ? 1 : 0,
              );
            break;
          case 'record':
            if (data.trackId === 0 || data.trackId === 1)
              this.engine.record(data.trackId);
            break;
          case 'play':
            if (data.trackId === 0 || data.trackId === 1)
              this.engine.play(data.trackId);
            break;
          case 'stop-track':
            if (data.trackId === 0 || data.trackId === 1)
              this.engine.stop_track(data.trackId);
            break;
          case 'clear':
            if (data.trackId === 0 || data.trackId === 1)
              this.engine.clear(data.trackId);
            break;
          case 'interrupt':
            this.engine.interrupt();
            break;
          case 'reset':
            this.engine.reset();
            break;
          case 'stop-transport':
            this.engine.stop_transport();
            break;
          case 'start-tracks': {
            // One message starts retained tracks before the next processing block.
            // Ignore stale starts while any track is active; never retrigger playback.
            const active = (trackId) => {
              const state = this.engine.track_state(trackId);
              return (
                state === TRACK_STATE.Recording ||
                state === TRACK_STATE.Playing ||
                state === TRACK_STATE.Overdubbing
              );
            };
            if (!active(0) && !active(1)) {
              for (let trackId = 0; trackId < 2; trackId++) {
                if (
                  this.engine.track_state(trackId) === TRACK_STATE.Stopped &&
                  this.engine.can_play(trackId)
                )
                  this.engine.play(trackId);
              }
            }
            break;
          }
        }
      }
      this.publishSnapshot();
    };
  }
  fxConfig(scope) {
    const flags = this.engine.fx_flags(scope);
    return flags & 1
      ? {
          type: 'LowPass',
          cutoffHz: this.engine.fx_cutoff(scope),
          bypassed: Boolean(flags & 2),
        }
      : { type: 'None' };
  }
  applyApplicationCommand(command) {
    if (this.failed) return false;
    switch (command.type) {
      case 'set-track-gain':
        if (
          (command.trackId !== 0 && command.trackId !== 1) ||
          !Number.isFinite(command.gain)
        )
          return false;
        this.engine.set_track_gain(command.trackId, command.gain);
        break;
      case 'set-track-mute':
        if (
          (command.trackId !== 0 && command.trackId !== 1) ||
          typeof command.muted !== 'boolean'
        )
          return false;
        this.engine.set_track_mute(command.trackId, command.muted ? 1 : 0);
        break;
      case 'set-master-gain':
        if (!Number.isFinite(command.gain)) return false;
        this.engine.set_master_gain(command.gain);
        break;
      case 'monitoring':
        if (typeof command.enabled !== 'boolean') return false;
        this.engine.set_monitoring(command.enabled ? 1 : 0);
        break;
      case 'set-mode':
        if (
          (command.trackId !== 0 && command.trackId !== 1) ||
          (command.mode !== 'Loop' && command.mode !== 'OneShot')
        )
          return false;
        this.engine.set_mode(
          command.trackId,
          command.mode === 'OneShot' ? 1 : 0,
        );
        break;
      case 'record':
        if (command.trackId !== 0 && command.trackId !== 1) return false;
        this.engine.record(command.trackId);
        break;
      case 'play':
        if (command.trackId !== 0 && command.trackId !== 1) return false;
        this.engine.play(command.trackId);
        break;
      case 'stop-track':
      case 'clear':
        if (command.trackId !== 0 && command.trackId !== 1) return false;
        if (command.type === 'clear') this.engine.clear(command.trackId);
        else this.engine.stop_track(command.trackId);
        break;
      case 'stop-transport':
        this.engine.stop_transport();
        break;
      case 'start-tracks': {
        const active = (id) => {
          const state = this.engine.track_state(id);
          return (
            state === TRACK_STATE.Recording ||
            state === TRACK_STATE.Playing ||
            state === TRACK_STATE.Overdubbing
          );
        };
        if (!active(0) && !active(1)) {
          for (let id = 0; id < 2; id++)
            if (
              this.engine.track_state(id) === TRACK_STATE.Stopped &&
              this.engine.can_play(id)
            )
              this.engine.play(id);
        }
        break;
      }
      case 'reset':
        this.engine.reset();
        break;
      case 'interrupt':
        this.engine.interrupt();
        break;
      default:
        return false;
    }
    return true;
  }
  publishSnapshot() {
    this.port.postMessage({
      type: 'snapshot',
      fx: [0, 1, 2, 3].map((scope) => {
        const flags = this.engine.fx_flags(scope);
        return {
          config: this.fxConfig(scope),
          transitioning: Boolean(flags & 4),
          removing: Boolean(flags & 8),
        };
      }),
      recordingRevisions: [0, 1].map((id) =>
        this.engine.recording_revision(id),
      ),
      masterGain: this.engine.master_gain(),
      failed: this.failed,
      monitoring: Boolean(this.engine.monitoring()),
      processedFrames: this.frames,
      transport: {
        running: Boolean(this.engine.transport_running()),
        positionSamples: this.engine.transport_position(),
        cycleLengthSamples: this.engine.cycle_length(),
      },
      tracks: [0, 1].map((trackId) => ({
        gain: this.engine.track_gain(trackId),
        muted: Boolean(this.engine.track_muted(trackId)),
        mode: this.engine.playback_mode(trackId) === 1 ? 'OneShot' : 'Loop',
        canSetMode: Boolean(this.engine.can_set_mode(trackId)),
        canSetLoop: Boolean(this.engine.can_set_loop(trackId)),
        state: TRACK_STATE_NAMES[this.engine.track_state(trackId)],
        lengthSamples: this.engine.loop_length(trackId),
        capturedSamples: this.engine.captured_samples(trackId),
        capacitySamples: this.engine.recording_capacity(trackId),
        captureLimitSamples: this.engine.capture_limit(trackId),
        canRecord: Boolean(this.engine.can_record(trackId)),
        canPlay: Boolean(this.engine.can_play(trackId)),
        canStop: Boolean(this.engine.can_stop(trackId)),
        positionSamples: this.engine.loop_position(trackId),
      })),
      inputLevel: this.inputLevel,
      outputLevel: this.outputLevel,
    });
  }
  process(inputs, outputs) {
    const channels = outputs[0];
    const count = channels[0].length;
    if (
      this.engine.memory.buffer !== this.memory ||
      count > this.input.length
    ) {
      this.failed = true;
      return false;
    }
    const source = inputs[0][0];
    this.blockSequence++;
    const commandCount = Math.min(32, this.commands.length);
    for (let index = 0; index < commandCount; index++) {
      const item = this.commands.shift();
      if (item.generation !== this.generation) {
        this.port.postMessage({
          commandId: item.commandId,
          generation: item.generation,
          status: 'stale',
        });
      } else {
        const applied = this.applyApplicationCommand(item.command);
        this.port.postMessage({
          commandId: item.commandId,
          generation: item.generation,
          status: applied ? 'applied' : 'failed',
          applicationFrame: this.frames,
          blockSequence: this.blockSequence,
          error: applied ? undefined : 'The audio engine rejected the command.',
        });
      }
    }
    for (let i = 0; i < count; i++) this.input[i] = source?.[i] ?? 0;
    if (this.engine.process(count) !== count) {
      this.failed = true;
      for (let channel = 0; channel < channels.length; channel++)
        channels[channel].fill(0);
      return false;
    }
    let inputPeak = 0,
      outputPeak = 0;
    for (let i = 0; i < count; i++) {
      inputPeak = Math.max(inputPeak, Math.abs(this.input[i]));
      outputPeak = Math.max(outputPeak, Math.abs(this.output[i]));
      for (let channel = 0; channel < channels.length; channel++)
        channels[channel][i] = this.output[i];
    }
    // Slowly decaying meters; silent output resets immediately when monitoring is off.
    this.inputLevel = Math.max(inputPeak, this.inputLevel * 0.999);
    this.outputLevel =
      this.engine.monitoring() ||
      this.engine.track_state(0) === TRACK_STATE.Playing ||
      this.engine.track_state(1) === TRACK_STATE.Playing ||
      this.engine.track_state(0) === TRACK_STATE.Overdubbing ||
      this.engine.track_state(1) === TRACK_STATE.Overdubbing
        ? Math.max(outputPeak, this.outputLevel * 0.999)
        : 0;
    if (
      this.exportSession?.checkpoint &&
      this.frames >= this.exportSession.deadline
    ) {
      this.engine.checkpoint_cancel();
      this.exportSession = null;
    }
    this.frames += count;
    return true;
  }
}
registerProcessor('loop-engine', LoopProcessor);
