/** Host-owned cancellation and cooperative yielding for archive operations. */
export interface SessionWork {
  checkCanceled(): void;
  yieldToHost(): Promise<void>;
}
