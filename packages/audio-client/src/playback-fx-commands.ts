import type { FxConfig } from '@loopbeats/domain';

export type PlaybackFxScope = 1 | 2 | 3;
export interface PlaybackFxReply {
  type: 'playback-fx-reply';
  scope: PlaybackFxScope;
  requestId: number;
  error?: string;
}

/** Bounded per-slot command ownership; one flight and one latest queued target. */
export class PlaybackFxCommands {
  private sequence = 0;
  private flights = new Map<
    PlaybackFxScope,
    { requestId: number; config: FxConfig }
  >();
  private queued = new Map<PlaybackFxScope, FxConfig>();
  private errors: (string | null)[] = [null, null, null];
  constructor(
    private readonly send: (
      scope: PlaybackFxScope,
      requestId: number,
      config: FxConfig,
    ) => void,
    private readonly changed: () => void,
  ) {}
  get pending() {
    return [1, 2, 3].map((scope) => this.flights.has(scope as PlaybackFxScope));
  }
  get errorSnapshot() {
    return [...this.errors];
  }
  desired(scope: PlaybackFxScope) {
    return this.queued.get(scope) ?? this.flights.get(scope)?.config;
  }
  request(scope: PlaybackFxScope, config: FxConfig, removing: boolean) {
    if (removing || this.flights.get(scope)?.config.type === 'None') {
      this.errors[scope - 1] =
        'FX is being removed. Try again after the transition.';
      this.changed();
      return;
    }
    if (this.flights.has(scope)) {
      this.queued.set(scope, config);
      return;
    }
    const requestId = ++this.sequence;
    this.flights.set(scope, { requestId, config });
    this.errors[scope - 1] = null;
    this.changed();
    this.send(scope, requestId, config);
  }
  reply(reply: PlaybackFxReply) {
    if (this.flights.get(reply.scope)?.requestId !== reply.requestId) return;
    this.flights.delete(reply.scope);
    const queued = this.queued.get(reply.scope);
    this.queued.delete(reply.scope);
    this.errors[reply.scope - 1] = reply.error ?? null;
    this.changed();
    if (queued && !reply.error) this.request(reply.scope, queued, false);
  }
  cancelQueued(scope?: PlaybackFxScope) {
    if (scope === undefined) this.queued.clear();
    else this.queued.delete(scope);
  }
  release() {
    this.flights.clear();
    this.queued.clear();
    this.errors.fill(null);
  }
}
