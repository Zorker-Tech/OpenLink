/** A foreground stream can yield control while preserving its unread iterator value. */
type HandoffReason = { kind: "background"; reason: "user" | "timeout" } | { kind: "abort" };

export class ShellStreamHandoff<T> {
  private nextRead: Promise<IteratorResult<T>> | undefined;
  private reason: HandoffReason | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolveStopped: (() => void) | undefined;
  private readonly stopped = new Promise<void>(resolve => { this.resolveStopped = resolve; });

  constructor(private readonly source: AsyncIterator<T>, private readonly timeoutMs: number) {}

  get handedOff(): boolean {
    return this.reason?.kind === "background";
  }

  get backgroundReason(): "user" | "timeout" | undefined {
    return this.reason?.kind === "background" ? this.reason.reason : undefined;
  }

  get stopReason(): HandoffReason | undefined {
    return this.reason;
  }

  requestBackground(): boolean {
    return this.stop({ kind: "background", reason: "user" });
  }

  abort(): void {
    this.stop({ kind: "abort" });
  }

  async *read(): AsyncIterable<T> {
    this.timer = setTimeout(() => this.stop({ kind: "background", reason: "timeout" }), this.timeoutMs);
    try {
      while (true) {
        this.nextRead = this.source.next();
        const raced = await Promise.race([
          this.nextRead.then(result => ({ kind: "item" as const, result })),
          this.stopped.then(() => ({ kind: "stopped" as const })),
        ]);
        if (raced.kind === "stopped") return;
        this.nextRead = undefined;
        if (raced.result.done) return;
        yield raced.result.value;
      }
    } finally {
      clearTimeout(this.timer);
    }
  }

  continueInBackground(): AsyncIterator<T> {
    if (this.nextRead === undefined) return this.source;
    const firstRead = this.nextRead;
    this.nextRead = undefined;
    let pendingFirst = true;
    return {
      next: async () => {
        if (pendingFirst) {
          pendingFirst = false;
          return firstRead;
        }
        return this.source.next();
      },
    };
  }

  private stop(reason: HandoffReason): boolean {
    if (this.reason !== undefined) return false;
    this.reason = reason;
    this.resolveStopped?.();
    return true;
  }
}
