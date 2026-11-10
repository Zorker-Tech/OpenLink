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

interface SnapshotRequestPort {
  snapshot(reason: SnapshotReason): Promise<void>;
}

export interface CodebaseSnapshotTriggerOptions {
  getSession(): SnapshotRequestPort | undefined;
  logger: { debug(message: string): void; warn(message: string, error?: unknown): void };
}

export class CodebaseSnapshotTrigger {
  private readonly recentReasons = new Set<string>();
  private failedAttempts = 0;
  private nextWarningAt = 1;

  constructor(private readonly dependencies: CodebaseSnapshotTriggerOptions) {}

  handle(reason: SnapshotReason): void {
    const session = this.dependencies.getSession();
    if (session == null) {
      this.dependencies.logger.debug(`snapshot trigger dropped (telemetry inactive): ${reason.type}`);
      return;
    }
    const identity = snapshotReasonKey(reason);
    if (this.recentReasons.has(identity)) return;

    this.remember(identity);
    this.requestSnapshot(session, reason, identity);
  }

  private remember(identity: string): void {
    this.recentReasons.add(identity);
    if (this.recentReasons.size <= MAX_HANDLED_REASONS) return;
    const oldest = this.recentReasons.values().next().value;
    if (oldest !== undefined) this.recentReasons.delete(oldest);
  }

  private requestSnapshot(session: SnapshotRequestPort, reason: SnapshotReason, identity: string): void {
    try {
      void session.snapshot(reason).catch((cause) => this.onFailure(identity, cause));
    } catch (cause) {
      this.onFailure(identity, cause);
    }
  }

  private onFailure(identity: string, cause: unknown): void {
    this.recentReasons.delete(identity);
    const attempt = ++this.failedAttempts;
    if (attempt < this.nextWarningAt) return;

    this.nextWarningAt *= 2;
    this.dependencies.logger.warn(`snapshot trigger failed (failure #${attempt})`, cause);
  }
}
