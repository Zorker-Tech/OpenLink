/**
 * What a write tells the model about afterwards, beyond the write itself.
 *
 * Two things happen to a file after it is written and both are worth saying. A canvas is type-checked as
 * part of being saved, so its diagnostics are run for the file just written and appended with their
 * severities and positions — a canvas that does not compile is the thing the model most needs to know, and
 * it is the only place those errors appear. And an agent store that is shared can conflict with another
 * agent's write, so a same-result barrier waits briefly for the conflict machinery to catch up and, when it
 * has something to say, appends its reminder.
 *
 * The barrier is deliberately forgiving, because it sits between the user and their answer. It has a
 * deadline, and when the deadline passes the write is reported as written with the conflict left to the
 * journal rather than being held back; a store that is not shared, a mount that is passive, or a failure to
 * sync all fall back to reading the journal once, and a journal that says nothing leaves the result alone.
 * What was already written is noted before the wait, so a write that is interrupted is still attributed to
 * the turn that made it. Every outcome is counted and reported to a caller that asked, because the timing of
 * this barrier is the kind of thing that has to be measurable to be tuned.
 */

import type { Context } from "../../../../context/context.ts"
import { createLogger } from "../../../../context/index.ts"
import { createCounter } from "../../../../metrics/index.ts"
import { canvasDiagnosticsExecutorResource } from "../../../../agent-exec/canvas-diagnostics.ts"
import { agentStoreConflictNoticeExecutorResource, conflictNoticeAck, conflictNoticeNoteDeferredEagerWrittenPaths, conflictNoticePeek, conflictNoticeRelease, conflictNoticeSyncAndPeek } from "../../../../agent-exec/agent-store-conflict-notice.ts"
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.ts"
import type { Executor, RemoteExecManager } from "../../../../agent-exec/executor-resources.ts"
import { CanvasDiagnosticsArgs, type CanvasDiagnosticsResult } from "../../../../proto/generated/agent/v1/canvas_diagnostics_exec_pb.ts"
import { DiagnosticSeverity, type Diagnostic } from "../../../../proto/generated/agent/v1/diagnostics_exec_pb.ts"
import { getConversationId } from "../../../utils/request-scope.ts"
import { CANVAS_POST_EDIT_DIAGNOSTICS_TIMEOUT_MS } from "../../../utils/config-overrides.ts"
import { delay } from "../../../../utils/promise-tools.ts"
import { isManagedCanvasPath } from "../../../../utils/canvas-paths.ts"

const logger = createLogger("@slate/agent");
const eagerStoreConflictBarrier = createCounter("agent.store.eager_barrier", {
  description: "Eager same-result agent-store conflict barrier outcomes.",
});

function recordEagerBarrierOutcome(ctx: Context, outcome: string): void {
  try {
    eagerStoreConflictBarrier.increment(ctx, 1, { outcome });
  } catch (error) {
    logger.warn(ctx, "Eager store conflict barrier telemetry failed", { error });
  }
}

export interface PostWriteDecorationOptions {
  readonly enableAgentStoreConflictNotices?: boolean | undefined;
  readonly writeBarrierTimeoutMs?: number | undefined;
  readonly forceGraceTimeoutMs?: number | undefined;
  readonly onWriteBarrier?: ((event: { readonly durationMs: number; readonly outcome: string }) => void) | undefined;
}

interface CanvasDiagnosticExecutor extends Executor<CanvasDiagnosticsArgs, CanvasDiagnosticsResult> {}

interface ConflictEvent {
  readonly eventId: string;
}

type ConflictKind = "not-applicable" | "mount-passive" | "timed-out" | "failed" | "completed";
type ConflictExecutor = Parameters<typeof conflictNoticeSyncAndPeek>[0];

interface ConflictPeekResult {
  readonly kind: ConflictKind;
  readonly reminder?: string | undefined;
  readonly events: readonly ConflictEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseConflictKind(value: unknown): ConflictKind | undefined {
  switch (value) {
    case "not-applicable":
    case "mount-passive":
    case "timed-out":
    case "failed":
    case "completed":
      return value;
    default:
      return undefined;
  }
}

function parseConflictPeekResult(value: unknown): ConflictPeekResult | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  const kind = parseConflictKind(value.kind);
  if (kind === undefined) return undefined;
  const rawEvents = value.events;
  if (!Array.isArray(rawEvents)) return undefined;
  const events: ConflictEvent[] = [];
  for (const rawEvent of rawEvents) {
    if (!isRecord(rawEvent) || typeof rawEvent.eventId !== "string") return undefined;
    events.push({ eventId: rawEvent.eventId });
  }
  return {
    kind,
    events,
    ...(typeof value.reminder === "string" ? { reminder: value.reminder } : {}),
  };
}

async function runCanvasPostEditDiagnostics(
  ctx: Context,
  executor: CanvasDiagnosticExecutor,
  filePath: string,
  timeoutMs: number,
  toolCallId: string,
): Promise<string | undefined> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof CANVAS_DIAGNOSTICS_TIMEOUT>((resolve) => {
    timeoutId = setTimeout(() => resolve(CANVAS_DIAGNOSTICS_TIMEOUT), timeoutMs);
  });
  try {
    const raced = await Promise.race([
      executor.execute(ctx, new CanvasDiagnosticsArgs({ path: filePath, toolCallId })),
      timeoutPromise,
    ]);
    if (raced === CANVAS_DIAGNOSTICS_TIMEOUT || raced.result.case !== "success") return undefined;
    const { path, diagnostics } = raced.result.value;
    const filtered = diagnostics.filter((diagnostic: Diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR || diagnostic.severity === DiagnosticSeverity.WARNING);
    if (filtered.length === 0) return "Canvas TypeScript check: no errors.";
    const lines = [`Canvas TypeScript check: ${filtered.length} issue${filtered.length > 1 ? "s" : ""} in ${path}:`];
    for (const diagnostic of filtered) {
      const severity = diagnostic.severity === DiagnosticSeverity.WARNING ? "WARNING" : "ERROR";
      const line = diagnostic.range?.start?.line ?? 0;
      const column = diagnostic.range?.start?.column ?? 0;
      const source = diagnostic.source ? ` (${diagnostic.source})` : "";
      lines.push(`  [${severity}] L${line}:${column} - ${diagnostic.message}${source}`);
    }
    return lines.join("\n");
  } catch {
    return undefined;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

const CANVAS_DIAGNOSTICS_TIMEOUT = Symbol("canvasPostEditDiagnosticsTimeout");

async function decorateWithCanvasDiagnostics(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  path: string,
  resultForModel: string,
  toolCallId: string,
): Promise<string> {
  if (!isManagedCanvasPath(path)) return resultForModel;
  let executor: CanvasDiagnosticExecutor;
  try {
    executor = resourceAccessor.get(canvasDiagnosticsExecutorResource);
  } catch {
    return resultForModel;
  }
  if (executor === undefined) return resultForModel;
  const diagnostics = await runCanvasPostEditDiagnostics(ctx, executor, path, CANVAS_POST_EDIT_DIAGNOSTICS_TIMEOUT_MS(ctx), toolCallId);
  return diagnostics === undefined ? resultForModel : `${resultForModel}\n\n${diagnostics}`;
}

const DEFAULT_WRITE_BARRIER_TIMEOUT_MS = 2_000;

async function decorateWithEagerStoreConflict(args: {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly path: string;
  readonly resultForModel: string;
  readonly writeBarrierTimeoutMs?: number | undefined;
  readonly forceGraceTimeoutMs?: number | undefined;
  readonly onWriteBarrier?: ((event: { readonly durationMs: number; readonly outcome: string }) => void) | undefined;
}): Promise<string> {
  const { ctx, resourceAccessor, path, resultForModel } = args;
  const deadlineMs = args.writeBarrierTimeoutMs ?? DEFAULT_WRITE_BARRIER_TIMEOUT_MS;
  const graceMs = Math.max(0, args.forceGraceTimeoutMs ?? deadlineMs);
  const outerDeadlineMs = deadlineMs > 0 ? deadlineMs + graceMs : 0;
  const barrierStartedAt = Date.now();
  let barrierOutcomeReported = false;
  const reportWriteBarrier = (outcome: string): void => {
    if (barrierOutcomeReported) return;
    barrierOutcomeReported = true;
    try {
      args.onWriteBarrier?.({ durationMs: Date.now() - barrierStartedAt, outcome });
    } catch {
    }
  };
  let executor: ConflictExecutor | undefined;
  try {
    executor = resourceAccessor.get(agentStoreConflictNoticeExecutorResource);
  } catch {
    return resultForModel;
  }
  if (executor === undefined) return resultForModel;
  const deadline = { expired: false };
  let raceOutcome: "eager" | "timeout" | undefined;
  const claimRace = (winner: "eager" | "timeout"): boolean => {
    if (raceOutcome !== undefined) return false;
    raceOutcome = winner;
    return true;
  };
  const isAbortSignalAborted = (): boolean => ctx.signal.aborted || deadline.expired;
  const conversationId = getConversationId(ctx);
  const conflictNoticeArgs = conversationId !== undefined ? { conversationId } : undefined;
  const noteDeferredForAbortRescue = async (): Promise<void> => {
    try {
      await conflictNoticeNoteDeferredEagerWrittenPaths(executor, ctx, [path], conflictNoticeArgs);
    } catch (error) {
      logger.warn(ctx, "Eager store conflict deferred-path note failed", { error });
    }
  };
  if (isAbortSignalAborted()) {
    await noteDeferredForAbortRescue();
    return resultForModel;
  }
  const releaseEagerEvents = async (eventIds: readonly string[]): Promise<void> => {
    if (eventIds.length === 0) return;
    try {
      await conflictNoticeRelease(executor, ctx, eventIds, conflictNoticeArgs);
    } catch (error) {
      logger.warn(ctx, "Eager store conflict release failed", { error });
    }
  };
  const ackIfStillLive = async (eventIds: readonly string[]): Promise<"aborted" | "acked" | "ack-failed"> => {
    if (isAbortSignalAborted() || !claimRace("eager")) {
      await releaseEagerEvents(eventIds);
      await noteDeferredForAbortRescue();
      return "aborted";
    }
    try {
      await conflictNoticeAck(executor, ctx, eventIds, conflictNoticeArgs);
      return "acked";
    } catch (error) {
      logger.warn(ctx, "Eager store conflict ack failed", { error });
      await releaseEagerEvents(eventIds);
      return "ack-failed";
    }
  };
  const fallbackJournalDrain = async (priorOutcome: string): Promise<string> => {
    const recordPrior = (): void => recordEagerBarrierOutcome(ctx, priorOutcome);
    if (isAbortSignalAborted()) {
      await noteDeferredForAbortRescue();
      recordPrior();
      return resultForModel;
    }
    let peeked: ConflictPeekResult | undefined;
    try {
      peeked = parseConflictPeekResult(await conflictNoticePeek(executor, ctx, conflictNoticeArgs));
    } catch (error) {
      logger.warn(ctx, "Eager store conflict journal-drain fallback failed", { error });
      recordPrior();
      return resultForModel;
    }
    if (peeked === undefined || (peeked.kind !== "completed" && peeked.kind !== "timed-out")) {
      recordPrior();
      return resultForModel;
    }
    const fallbackReminder = peeked.reminder;
    const fallbackEventIds = peeked.events.map(event => event.eventId);
    if (fallbackReminder === undefined || fallbackReminder.length === 0) {
      await releaseEagerEvents(fallbackEventIds);
      recordPrior();
      return resultForModel;
    }
    if (fallbackEventIds.length === 0) {
      recordPrior();
      return resultForModel;
    }
    if (isAbortSignalAborted()) {
      await releaseEagerEvents(fallbackEventIds);
      await noteDeferredForAbortRescue();
      recordPrior();
      return resultForModel;
    }
    const decorated = `${resultForModel}\n\n${fallbackReminder}`;
    if (await ackIfStillLive(fallbackEventIds) === "aborted") {
      recordPrior();
      return resultForModel;
    }
    recordEagerBarrierOutcome(ctx, "journal_fallback");
    return decorated;
  };
  if (!(deadlineMs > 0)) {
    reportWriteBarrier("skipped");
    return fallbackJournalDrain("degraded");
  }
  const runEager = async (): Promise<string> => {
    try {
      const result = parseConflictPeekResult(await conflictNoticeSyncAndPeek(executor, ctx, {
        writtenPaths: [path],
        eager: true,
        timeoutMs: deadlineMs,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }));
      if (result === undefined) {
        reportWriteBarrier("error");
        return fallbackJournalDrain("error");
      }
      switch (result.kind) {
        case "not-applicable": reportWriteBarrier("absent"); return fallbackJournalDrain("degraded");
        case "mount-passive": reportWriteBarrier("passive"); return fallbackJournalDrain("degraded");
        case "timed-out": {
          const reminder = result.reminder;
          if (reminder === undefined || reminder.length === 0 || result.events.length === 0) {
            reportWriteBarrier("timeout");
            return fallbackJournalDrain("timed_out");
          }
          const eventIds = result.events.map(event => event.eventId);
          if (isAbortSignalAborted()) {
            await releaseEagerEvents(eventIds);
            await noteDeferredForAbortRescue();
            reportWriteBarrier("timeout");
            return resultForModel;
          }
          const decorated = `${resultForModel}\n\n${reminder}`;
          if (await ackIfStillLive(eventIds) === "aborted") {
            reportWriteBarrier("timeout");
            return resultForModel;
          }
          recordEagerBarrierOutcome(ctx, "attributed_timed_out");
          reportWriteBarrier("timeout");
          return decorated;
        }
        case "failed": reportWriteBarrier("error"); return fallbackJournalDrain("error");
        case "completed": break;
      }
      const reminder = result.reminder;
      const eventIds = result.events.map(event => event.eventId);
      if (isAbortSignalAborted()) {
        await releaseEagerEvents(eventIds);
        await noteDeferredForAbortRescue();
        reportWriteBarrier(deadline.expired ? "timeout" : "synced");
        return resultForModel;
      }
      if (reminder === undefined || reminder.length === 0) {
        reportWriteBarrier("synced");
        return fallbackJournalDrain("clean");
      }
      const decorated = `${resultForModel}\n\n${reminder}`;
      if (await ackIfStillLive(eventIds) === "aborted") {
        reportWriteBarrier(deadline.expired ? "timeout" : "synced");
        return resultForModel;
      }
      recordEagerBarrierOutcome(ctx, "attributed");
      try {
        logger.info(ctx, "Local-sync eager conflict barrier attributed", { eventCount: eventIds.length });
      } catch {
      }
      reportWriteBarrier("synced");
      return decorated;
    } catch (error) {
      logger.warn(ctx, "Eager store conflict barrier failed", { error });
      reportWriteBarrier("error");
      return fallbackJournalDrain("error");
    }
  };
  return Promise.race([
    runEager().finally(() => {
      if (raceOutcome === undefined) raceOutcome = "eager";
    }),
    delay(outerDeadlineMs).then(async () => {
      if (!claimRace("timeout")) return new Promise<string>(() => {});
      deadline.expired = true;
      await noteDeferredForAbortRescue();
      reportWriteBarrier("timeout");
      return resultForModel;
    }),
  ]);
}

export async function decoratePostWriteResultForModel(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  path: string,
  resultForModel: string,
  toolCallId: string,
  options?: PostWriteDecorationOptions,
): Promise<string> {
  const withCanvas = await decorateWithCanvasDiagnostics(ctx, resourceAccessor, path, resultForModel, toolCallId);
  if (options?.enableAgentStoreConflictNotices !== true) return withCanvas;
  return decorateWithEagerStoreConflict({
    ctx,
    resourceAccessor,
    path,
    resultForModel: withCanvas,
    writeBarrierTimeoutMs: options.writeBarrierTimeoutMs,
    forceGraceTimeoutMs: options.forceGraceTimeoutMs,
    onWriteBarrier: options.onWriteBarrier,
  });
}
