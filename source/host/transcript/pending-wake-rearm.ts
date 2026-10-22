/**
 * Re-arming the wakes a conversation is waiting for.
 *
 * What the ledger of pending wakes holds is turned back into work when a conversation is recreated, unless that carry
 * is switched off — so a restart does not silently drop something that was going to happen.
 */
import type { TranscriptManagerLike } from "./transcript-hub.ts";

/** The environment variable that switches the carry off. */
const DISABLE_CARRY_ENV = "SLATE_DISABLE_RECREATE_WAKE_CARRY";

/** One hour, in the milliseconds the stale age is given in. */
const HOUR_MS = 60 * 60 * 1_000;

/** The outcomes a wake report can carry. */
const REARMED = "rearmed";
const REARM_FAILED = "rearm_failed";
const REARM_SKIPPED = "rearm_skipped";

/** Whether carrying pending wakes across a recreation is switched off. */
export function isRecreateWakeCarryDisabled(): boolean {
  return process.env[DISABLE_CARRY_ENV] === "1";
}

/** How old a pending wake may be before it is pruned instead of re-armed. */
export const PENDING_WAKE_STALE_MAX_AGE_MS = 48 * HOUR_MS;

/** The kinds of work a pending wake can stand for. */
type PendingWakeKind = "cloud-agent" | "shell" | "subagent";

/** One pending wake as the store keeps it. */
interface PendingWakeRecord {
  agentId: string;
  kind: PendingWakeKind;
  workId: string;
  markedAtMs: number;
  quietOrigin?: unknown;
  title?: string;
  subagentType?: string;
  interruptedByRecreate?: boolean;
}

/** How a re-arm reports what became of one wake. */
type WakeReport = (outcome: string, reason?: string) => void;

/** The object that is spread into a marker when the caller has a quiet origin, and nothing when it does not. */
function quietOriginField(value: unknown): { quietOrigin?: unknown } {
  return value == null ? {} : { quietOrigin: value };
}

/** The object that is spread into a wake when it has a title. */
function titleField(value: string | undefined): { title?: string } {
  return value == null ? {} : { title: value };
}

/** The object that is spread into a wake when it has a subagent type. */
function subagentTypeField(value: string | undefined): { subagentType?: string } {
  return value == null ? {} : { subagentType: value };
}

/** Whether a cloud agent watch is already armed for a piece of work. */
function watchIsArmed(runner: { getPendingCloudAgentWatchBcIds(): readonly string[] }, workId: string): boolean {
  return runner.getPendingCloudAgentWatchBcIds().includes(workId);
}

/** The telemetry object a re-arm reports through. */
type WakeTelemetry = TranscriptManagerLike["telemetry"];

/** Reports a pruned wake. */
function reportPrunedWake(
  telemetry: WakeTelemetry,
  record: PendingWakeRecord,
  nowMs: number,
): void {
  telemetry.reportPendingWake({
    conversationId: record.agentId,
    outcome: "pruned",
    kind: record.kind,
    workId: record.workId,
    ageMs: nowMs - record.markedAtMs,
    reason: "stale",
    isQuietOrigin: record.quietOrigin != null,
  });
}

/** Reports a wake that was left alone because its agent is gone. */
function reportSkippedGoneWake(
  telemetry: WakeTelemetry,
  record: PendingWakeRecord,
  nowMs: number,
): void {
  telemetry.reportPendingWake({
    conversationId: record.agentId,
    outcome: REARM_SKIPPED,
    kind: record.kind,
    workId: record.workId,
    ageMs: nowMs - record.markedAtMs,
    reason: "agent_gone",
    isQuietOrigin: record.quietOrigin != null,
  });
}

/** Re-arms the wakes of a conversation after a recreation. */
export class PendingWakeRearm {
  constructor(readonly tm: TranscriptManagerLike) {}

  /** Writes a pending wake down, when the store is there and its agent is not deleted, and reports whether it landed. */
  persistPendingWake(request: {
    parentAgentId: string;
    kind: PendingWakeKind;
    workId: string;
    quietOrigin?: unknown;
    title: string;
    subagentType?: string;
  }): boolean {
    const store = this.tm.pendingWakeStore;
    if (store == null || this.tm.sessions.deletedAgentIds.has(request.parentAgentId)) return false;
    const written = store.markPending({
      agentId: request.parentAgentId,
      kind: request.kind,
      workId: request.workId,
      markedAtMs: Date.now(),
      ...quietOriginField(request.quietOrigin),
      title: request.title,
      ...subagentTypeField(request.subagentType),
    });
    this.tm.telemetry.reportPendingWake({
      conversationId: request.parentAgentId,
      outcome: written ? "persisted" : "persist_failed",
      kind: request.kind,
      workId: request.workId,
      isQuietOrigin: request.quietOrigin != null,
    });
    return written;
  }

  /** Clears a pending wake that has settled, and reports and announces it when it was there. */
  clearSettledPendingWake(cleared: {
    agentId: string;
    kind: PendingWakeKind;
    workId: string;
  }): void {
    const store = this.tm.pendingWakeStore;
    if (store == null || !store.clearOne(cleared.agentId, cleared.kind, cleared.workId)) return;
    this.tm.telemetry.reportPendingWake({
      conversationId: cleared.agentId,
      outcome: "settled",
      kind: cleared.kind,
      workId: cleared.workId,
    });
    this.tm.roster.emitAsyncTasksForAgent(cleared.agentId);
  }

  /** Disarms a pending wake because the work was aborted, reporting it when it was there. */
  disarmPendingWake(request: {
    parentAgentId: string;
    kind: PendingWakeKind;
    workId: string;
  }): void {
    const store = this.tm.pendingWakeStore;
    if (store == null || !store.clearOne(request.parentAgentId, request.kind, request.workId)) return;
    this.tm.telemetry.reportPendingWake({
      conversationId: request.parentAgentId,
      outcome: "settled",
      kind: request.kind,
      workId: request.workId,
      reason: "aborted",
    });
    this.tm.roster.emitAsyncTasksForAgent(request.parentAgentId);
  }

  /** Prunes the stale wakes, then re-arms each remaining one that still has an agent to run under. */
  async rearmPendingWakes(): Promise<void> {
    const store = this.tm.pendingWakeStore;
    if (store == null || !this.tm.execution.canExecute) return;
    const now = Date.now();
    for (const pruned of store.pruneStale(PENDING_WAKE_STALE_MAX_AGE_MS, now) as PendingWakeRecord[]) {
      reportPrunedWake(this.tm.telemetry, pruned, now);
    }
    for (const record of store.listPending() as PendingWakeRecord[]) {
      if (this.tm.sessions.isAgentGone(record.agentId)) {
        reportSkippedGoneWake(this.tm.telemetry, record, now);
        continue;
      }
      if (!(record.kind === "shell" && record.interruptedByRecreate === true)) {
        store.clearOne(record.agentId, record.kind, record.workId);
      }
      void this.rearmPendingWake(record, now);
    }
  }

  /** Re-arms one wake: it resolves the session, reports why it cannot, and dispatches the kind of work it names. */
  async rearmPendingWake(
    record: PendingWakeRecord,
    nowMs: number,
    options?: { successReason?: string },
  ): Promise<void> {
    const reportOutcome: WakeReport = (outcome, reason) => {
      if (outcome === REARM_FAILED) this.tm.pendingWakeStore?.markPending(record);
      const effectiveReason = reason ?? (outcome === REARMED ? options?.successReason : undefined);
      this.tm.telemetry.reportPendingWake({
        conversationId: record.agentId,
        outcome,
        kind: record.kind,
        workId: record.workId,
        ageMs: nowMs - record.markedAtMs,
        ...(effectiveReason == null ? {} : { reason: effectiveReason }),
        isQuietOrigin: record.quietOrigin != null,
      });
    };
    let session: any;
    try {
      session = await this.tm.sessions.resolveBackgroundSession(record.agentId);
    } catch {
      reportOutcome(REARM_FAILED, "session_unavailable");
      return;
    }
    if (this.tm.groupChat.isGroupSession(session)) {
      if (record.kind === "shell" && record.interruptedByRecreate === true) {
        this.tm.pendingWakeStore?.clearOne(record.agentId, record.kind, record.workId);
      }
      reportOutcome(REARM_SKIPPED, "group_session");
      return;
    }
    try {
      if (record.kind === "cloud-agent") this.rearmCloudAgentWake(session, record, reportOutcome);
      else if (record.kind === "shell" && record.interruptedByRecreate === true) {
        this.tm.upgradeResume.deliverRecreateInterruptedShellNotice(record, reportOutcome);
      } else if (record.kind === "shell") this.rearmShellWake(session, record, reportOutcome);
      else if (record.kind === "subagent") this.reviveParentForLostSubagentWake(record, reportOutcome);
      else reportOutcome(REARM_SKIPPED, "unsupported_kind");
    } catch {
      reportOutcome(REARM_FAILED, "error");
    }
  }

  /** Re-arms a cloud agent wake: keeps the existing watch, or starts one and reports whether it took. */
  rearmCloudAgentWake(session: any, record: PendingWakeRecord, reportOutcome: WakeReport): void {
    const runner = this.tm.runnerRegistry.getRunner(session);
    if (watchIsArmed(runner, record.workId)) {
      this.persistPendingWake({
        parentAgentId: record.agentId,
        kind: "cloud-agent",
        workId: record.workId,
        title: record.title ?? `Cloud agent ${record.workId}`,
        ...quietOriginField(record.quietOrigin),
      });
      reportOutcome(REARMED);
      return;
    }
    runner.watchCloudAgent(record.workId, {
      afterFollowup: false,
      ...quietOriginField(record.quietOrigin),
    });
    reportOutcome(
      watchIsArmed(runner, record.workId) ? REARMED : REARM_FAILED,
      watchIsArmed(runner, record.workId) ? undefined : "watch_not_armed",
    );
  }

  /** Re-arms a shell wake by watching the background shell again. */
  rearmShellWake(session: any, record: PendingWakeRecord, reportOutcome: WakeReport): void {
    this.tm.runnerRegistry.getRunner(session).watchBackgroundShell(record.workId, {
      ...titleField(record.title),
      ...quietOriginField(record.quietOrigin),
    });
    reportOutcome(REARMED);
  }

  /** Revives the parent of a subagent whose wake was lost, by delivering the failure it never got. */
  reviveParentForLostSubagentWake(record: PendingWakeRecord, reportOutcome: WakeReport): void {
    this.persistPendingWake({
      parentAgentId: record.agentId,
      kind: "subagent",
      workId: record.workId,
      title: record.title ?? "Background task",
      ...subagentTypeField(record.subagentType),
      ...quietOriginField(record.quietOrigin),
    });
    reportOutcome(REARMED, "interrupted_completion");
    this.tm.backgroundWakes.handleBackgroundSubagentCompletion({
      parentAgentId: record.agentId,
      subagentAgentId: record.workId,
      subagentType: record.subagentType ?? "task",
      toolCallId: "",
      title: record.title ?? "Background task",
      status: "error",
      result:
        "A host restart interrupted this background task before its result could be delivered; its in-process run did not survive, so its final state is unknown. Check its transcript (Await with this task id) if you need what it got through, and dispatch a fresh background task if the work still matters.",
      ...quietOriginField(record.quietOrigin),
    });
  }

  /** Queues items for an agent that still exists, and answers whether it did. */
  enqueuePendingWake<T>(queue: Map<string, T[]>, agentId: string, items: T[]): boolean {
    if (this.tm.sessions.isAgentGone(agentId)) return false;
    const queued = queue.get(agentId) ?? [];
    queued.push(...items);
    queue.set(agentId, queued);
    return true;
  }
}
