/**
 * Asking the telemetry session for a codebase snapshot, once per reason.
 *
 * A reason is handled once, and one that failed is handled again — the failure forgets it — while the set of handled
 * reasons stays bounded. Failures are logged on a doubling schedule, so a session that is broken does not fill the log.
 */

export const MAX_HANDLED_REASONS = 1_000;

export type SnapshotReason = { readonly type: "AGENT_REQUEST_START" | "AGENT_REQUEST_END"; readonly requestId: string };

/** What makes two reasons the same one. */
export function snapshotReasonKey(reason: SnapshotReason): string {
  return JSON.stringify([reason.type, reason.requestId]);
}

interface SnapshotSession {
  snapshot(reason: SnapshotReason): Promise<void>;
}

export interface CodebaseSnapshotTriggerOptions {
  getSession(): SnapshotSession | undefined;
  logger: { debug(message: string): void; warn(message: string, error?: unknown): void };
}

export class CodebaseSnapshotTrigger {
  private readonly handled = new Set<string>();
  private failureCount = 0;
  private nextFailureLogAt = 1;

  constructor(private readonly options: CodebaseSnapshotTriggerOptions) {}

  handle(reason: SnapshotReason): void {
    const session = this.options.getSession();
    if (session == null) {
      this.options.logger.debug(`snapshot trigger dropped (telemetry inactive): ${reason.type}`);
      return;
    }
    const key = snapshotReasonKey(reason);
    if (this.handled.has(key)) return;
    this.handled.add(key);
    this.forgetOldestReasonWhenFull();
    void session.snapshot(reason).catch((error) => {
      this.handled.delete(key);
      this.failureCount += 1;
      if (this.failureCount >= this.nextFailureLogAt) {
        this.nextFailureLogAt *= 2;
        this.options.logger.warn(`snapshot trigger failed (failure #${this.failureCount})`, error);
      }
    });
  }

  /** A session that lives long enough to see more reasons than the bound keeps the most recent ones. */
  private forgetOldestReasonWhenFull(): void {
    if (this.handled.size <= MAX_HANDLED_REASONS) return;
    const oldest = this.handled.values().next().value;
    if (oldest != null) this.handled.delete(oldest);
  }
}
