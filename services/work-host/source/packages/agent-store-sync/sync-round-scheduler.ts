/**
 * Taking one sync round at a time.
 *
 * A round that arrives while another is running is remembered rather than run alongside it, and a full round absorbs
 * the single-path rounds that were waiting; what is cancelled stops the round it was asked about.
 */

/** What a round covers: the whole store, or one path inside it. */
type RoundKind = "full" | "path";

/** The work of one round, handed the signal that says a full round should stand aside. */
type RoundBody<T> = (signal: AbortSignal | undefined) => Promise<T>;

/** A round waiting its turn, with the promise its caller is holding. */
interface QueuedRound<T> {
  readonly kind: RoundKind;
  readonly body: RoundBody<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/** The signal a round that was abandoned resolves the pump with, so the pump knows to stop waiting for it. */
const ABANDONED = Symbol("sync-round-abandoned");

export class SyncRoundStoodAsideError extends Error {
  constructor() {
    super("Agent store full sync stood aside for path sync");
    this.name = "SyncRoundStoodAsideError";
  }
}

export function isSyncRoundStoodAsideError(error: unknown): error is SyncRoundStoodAsideError {
  return error instanceof SyncRoundStoodAsideError;
}

/**
 * Runs the store's sync rounds one after another.
 *
 * A path round goes in front of a full round that is still waiting — a full round covers it anyway — and stops a full
 * round that is already running, which will not be needed once the path has been read.
 */
export class SyncRoundScheduler<T = unknown> {
  private readonly queue: QueuedRound<T>[] = [];
  private pumping: Promise<void> | undefined;
  /** The stand-aside handle of the full round that is running, if one is. */
  private runningFullRound: AbortController | undefined;
  /** Rejects the round the pump is waiting for, when a watchdog decides it is wedged. */
  private abandonRunningRound: ((reason?: unknown) => void) | undefined;

  enqueue(kind: RoundKind, body: RoundBody<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const round: QueuedRound<T> = { kind, body, resolve, reject };
      if (kind === "path") {
        this.runningFullRound?.abort(new SyncRoundStoodAsideError());
        const waitingFull = this.queue.findIndex((queued) => queued.kind === "full");
        this.queue.splice(waitingFull === -1 ? this.queue.length : waitingFull, 0, round);
      } else {
        this.queue.push(round);
      }
      this.startPump();
    });
  }

  /**
   * Unjam the pump after a session watchdog abandons a wedged round. Rejects not-yet-started pending entries, stops
   * awaiting the in-flight body (which continues in the background and still settles its enqueue promise), and lets a
   * later `enqueue` start a fresh pump once fail-fast clears.
   */
  abandonInFlight(): void {
    for (const round of this.queue.splice(0)) round.reject(new Error("Agent store sync round abandoned by watchdog"));
    this.abandonRunningRound?.(ABANDONED);
    this.abandonRunningRound = undefined;
    this.runningFullRound = undefined;
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.pumping !== undefined) await (this.pumping ?? Promise.resolve());
  }

  /** Starts the pump unless it is already running, and starts it again for anything that arrived as it finished. */
  private startPump(): void {
    if (this.pumping !== undefined) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (this.queue.length > 0) this.startPump();
    });
  }

  /**
   * Runs the queue in order.
   *
   * One round at a time, and each is awaited in the same step that settles it: a round that finishes hands its result
   * over here, and only then does the next one start, so a caller's continuation and the next round keep the order the
   * round was settled in.
   */
  private async pump(): Promise<void> {
    while (this.queue.length > 0) {
      const round = this.queue.shift();
      if (round === undefined) return;
      const standAside = round.kind === "full" ? new AbortController() : undefined;
      if (standAside !== undefined) this.runningFullRound = standAside;
      const body = round.body(standAside?.signal);
      const abandoned = new Promise<never>((_resolve, reject) => {
        this.abandonRunningRound = reject;
      });
      try {
        round.resolve(await Promise.race([body, abandoned]));
      } catch (error) {
        if (error === ABANDONED) {
          // The body is still running: it settles the caller's promise when it finishes, and the pump stops here.
          void body.then(round.resolve, round.reject);
          return;
        }
        round.reject(error);
      } finally {
        if (this.abandonRunningRound !== undefined) this.abandonRunningRound = undefined;
        if (this.runningFullRound === standAside) this.runningFullRound = undefined;
      }
    }
  }
}
