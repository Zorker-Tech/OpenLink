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
import { agentStoreConflictNoticeExecutorResource, conflictNoticeAck, conflictNoticeNoteDeferredEagerWrittenPaths, conflictNoticePeek, conflictNoticeRelease, conflictNoticeSyncAndPeek } from "../../../../agent-exec/agent-store-conflict-notice.ts"
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../../agent-exec/executor-resources.ts"
import {
  canvasDiagnosticsReaderFromResources,
  type SlateCanvasDiagnostic,
  type SlateCanvasDiagnosticsReader,
} from "../../../../../adapters/interop/agent/canvas-diagnostics-operation-adapter.ts"
import { getConversationId } from "../../../utils/request-scope.ts"
import { CANVAS_POST_EDIT_DIAGNOSTICS_TIMEOUT_MS } from "../../../utils/config-overrides.ts"
import { delay } from "../../../../utils/promise-tools.ts"
import { isWorkspaceCanvasDocument } from "../../../../utils/canvas-paths.ts"


const logger = createLogger("@slate/agent");

const eagerStoreConflictBarrier = createCounter("agent.store.eager_barrier", {
  description: "Eager same-result agent-store conflict barrier outcomes.",
});

/** The outcomes a barrier reports when it is switched off, and when it falls back to the journal. */
const OUTCOME_SKIPPED = "skipped";
const OUTCOME_ABSENT = "absent";
const OUTCOME_PASSIVE = "passive";
const OUTCOME_ERROR = "error";
const OUTCOME_TIMEOUT = "timeout";
const OUTCOME_SYNCED = "synced";
const OUTCOME_DEGRADED = "degraded";
const OUTCOME_TIMED_OUT = "timed_out";
const OUTCOME_CLEAN = "clean";
const OUTCOME_ATTRIBUTED = "attributed";
const OUTCOME_ATTRIBUTED_TIMED_OUT = "attributed_timed_out";
const OUTCOME_JOURNAL_FALLBACK = "journal_fallback";

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

/** One conflict the journal still holds, by the id the store gave it. */
interface ConflictEvent {
  readonly eventId: string;
}

type ConflictKind = "not-applicable" | "mount-passive" | "timed-out" | "failed" | "completed";
type ConflictExecutor = Parameters<typeof conflictNoticeSyncAndPeek>[0];

/** One read of the conflict journal, reduced to what the barrier works with. */
interface ConflictPeekResult {
  readonly kind: ConflictKind;
  readonly reminder?: string | undefined;
  readonly events: readonly ConflictEvent[];
}

const CONFLICT_KINDS: ReadonlySet<string> = new Set(["not-applicable", "mount-passive", "timed-out", "failed", "completed"]);

/** The kind of answer a conflict lookup gave, when it is one this module knows. */
function parseConflictKind(value: unknown): ConflictKind | undefined {
  return typeof value === "string" && CONFLICT_KINDS.has(value) ? (value as ConflictKind) : undefined;
}

/** A JSON object, which is what every conflict answer is. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The events a conflict answer carried, or nothing when one of them is not an event. */
function parseConflictEvents(value: unknown): ConflictEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: ConflictEvent[] = [];
  for (const rawEvent of value) {
    if (!isObjectLike(rawEvent) || typeof rawEvent.eventId !== "string") return undefined;
    events.push({ eventId: rawEvent.eventId });
  }
  return events;
}

/** One conflict answer, read into the shape the barrier works with. */
function parseConflictPeekResult(value: unknown): ConflictPeekResult | undefined {
  if (!isObjectLike(value) || typeof value.kind !== "string") return undefined;
  const kind = parseConflictKind(value.kind);
  if (kind === undefined) return undefined;
  const events = parseConflictEvents(value.events);
  if (events === undefined) return undefined;
  return typeof value.reminder === "string" ? { kind, events, reminder: value.reminder } : { kind, events };
}

const CANVAS_DIAGNOSTICS_TIMEOUT = Symbol("canvasPostEditDiagnosticsTimeout");
const NO_CANVAS_ISSUES = "Canvas TypeScript check: no errors.";

/** One diagnostic as the model reads it: its severity, position, message and source. */
function formatCanvasDiagnostic(diagnostic: SlateCanvasDiagnostic): string {
  const severity = diagnostic.severity === "warning" ? "WARNING" : "ERROR";
  const source = diagnostic.source ? ` (${diagnostic.source})` : "";
  return `  [${severity}] L${diagnostic.line}:${diagnostic.column} - ${diagnostic.message}${source}`;
}

/** What a canvas check found, or nothing when there was nothing worth appending. */
function formatCanvasIssues(path: string, diagnostics: readonly SlateCanvasDiagnostic[]): string | undefined {
  const filtered = diagnostics.filter(
    diagnostic => diagnostic.severity === "error" || diagnostic.severity === "warning",
  );
  if (filtered.length === 0) return NO_CANVAS_ISSUES;
  const heading = `Canvas TypeScript check: ${filtered.length} issue${filtered.length > 1 ? "s" : ""} in ${path}:`;
  return [heading, ...filtered.map(formatCanvasDiagnostic)].join("\n");
}

/** Runs the canvas check for a file that was just written, bounded by its own timeout. */
async function runCanvasPostEditDiagnostics(
  ctx: Context,
  reader: SlateCanvasDiagnosticsReader,
  filePath: string,
  timeoutMs: number,
  toolCallId: string,
): Promise<string | undefined> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof CANVAS_DIAGNOSTICS_TIMEOUT>((resolve) => {
    timeoutId = setTimeout(() => resolve(CANVAS_DIAGNOSTICS_TIMEOUT), timeoutMs);
  });
  try {
    const raced = await Promise.race([reader.read(ctx, filePath, toolCallId), timedOut]);
    if (raced === CANVAS_DIAGNOSTICS_TIMEOUT || raced === undefined) return undefined;
    return formatCanvasIssues(raced.path, raced.diagnostics);
  } catch {
    return undefined;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Appends what the canvas check found for the file that was just written. */
async function decorateWithCanvasDiagnostics(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  path: string,
  resultForModel: string,
  toolCallId: string,
): Promise<string> {
  if (!isWorkspaceCanvasDocument(path)) return resultForModel;
  const reader = canvasDiagnosticsReaderFromResources(resourceAccessor);
  if (reader === undefined) return resultForModel;
  const diagnostics = await runCanvasPostEditDiagnostics(ctx, reader, path, CANVAS_POST_EDIT_DIAGNOSTICS_TIMEOUT_MS(ctx), toolCallId);
  return diagnostics === undefined ? resultForModel : `${resultForModel}\n\n${diagnostics}`;
}

/** The write's own result with what the barrier found appended. */
function withReminder(resultForModel: string, reminder: string): string {
  return `${resultForModel}\n\n${reminder}`;
}

/** The conflict notice executor, or nothing when this session does not have one. */
function conflictNoticeExecutor(resourceAccessor: ResourceAccessor<RemoteExecManager>): ConflictExecutor | undefined {
  try {
    return resourceAccessor.get(agentStoreConflictNoticeExecutorResource);
  } catch {
    return undefined;
  }
}

/** The conversation the notice operations are scoped to, when the context names one. */
function conflictNoticeTarget(ctx: Context): { readonly conversationId: string } | undefined {
  const conversationId = getConversationId(ctx);
  return conversationId !== undefined ? { conversationId } : undefined;
}

const DEFAULT_WRITE_BARRIER_TIMEOUT_MS = 2_000;

/** One eager same-result store conflict barrier, from the write to its answer. */
interface EagerStoreConflictArgs {
  readonly ctx: Context;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly path: string;
  readonly resultForModel: string;
  readonly writeBarrierTimeoutMs?: number | undefined;
  readonly forceGraceTimeoutMs?: number | undefined;
  readonly onWriteBarrier?: ((event: { readonly durationMs: number; readonly outcome: string }) => void) | undefined;
}

/** A barrier's answer: the write as it was, plus a reminder when the store had one. */
async function decorateWithEagerStoreConflict(args: EagerStoreConflictArgs): Promise<string> {
  const { ctx, path, resultForModel } = args;
  const writeBarrierTimeoutMs = args.writeBarrierTimeoutMs ?? DEFAULT_WRITE_BARRIER_TIMEOUT_MS;
  const graceTimeoutMs = Math.max(0, args.forceGraceTimeoutMs ?? writeBarrierTimeoutMs);
  const outerDeadlineMs = writeBarrierTimeoutMs > 0 ? writeBarrierTimeoutMs + graceTimeoutMs : 0;
  const barrierStartedAt = Date.now();
  let barrierReported = false;
  const reportBarrier = (outcome: string): void => {
    if (barrierReported) return;
    barrierReported = true;
    try {
      args.onWriteBarrier?.({ durationMs: Date.now() - barrierStartedAt, outcome });
    } catch {
    }
  };

  const conflictExecutor = conflictNoticeExecutor(args.resourceAccessor);
  if (conflictExecutor === undefined) return resultForModel;

  const deadline = { expired: false };
  let raceWinner: "eager" | "timeout" | undefined;
  const claimRace = (winner: "eager" | "timeout"): boolean => {
    if (raceWinner !== undefined) return false;
    raceWinner = winner;
    return true;
  };
  const isBarrierAborted = (): boolean => ctx.signal.aborted || deadline.expired;
  const noticeTarget = conflictNoticeTarget(ctx);
  const eventIdsOf = (events: readonly ConflictEvent[]): string[] => events.map((event) => event.eventId);

  const noteDeferredPaths = async (): Promise<void> => {
    try {
      await conflictNoticeNoteDeferredEagerWrittenPaths(conflictExecutor, ctx, [path], noticeTarget);
    } catch (error) {
      logger.warn(ctx, "Eager store conflict deferred-path note failed", { error });
    }
  };
  if (isBarrierAborted()) {
    await noteDeferredPaths();
    return resultForModel;
  }
  const releaseEvents = async (eventIds: readonly string[]): Promise<void> => {
    if (eventIds.length === 0) return;
    try {
      await conflictNoticeRelease(conflictExecutor, ctx, eventIds, noticeTarget);
    } catch (error) {
      logger.warn(ctx, "Eager store conflict release failed", { error });
    }
  };
  const releaseAndNote = async (eventIds: readonly string[]): Promise<void> => {
    await releaseEvents(eventIds);
    await noteDeferredPaths();
  };
  const acknowledgeEvents = async (eventIds: readonly string[]): Promise<"aborted" | "acked" | "ack-failed"> => {
    if (isBarrierAborted() || !claimRace("eager")) {
      await releaseAndNote(eventIds);
      return "aborted";
    }
    try {
      await conflictNoticeAck(conflictExecutor, ctx, eventIds, noticeTarget);
      return "acked";
    } catch (error) {
      logger.warn(ctx, "Eager store conflict ack failed", { error });
      await releaseEvents(eventIds);
      return "ack-failed";
    }
  };

  /** Reads the journal once, for a barrier that was skipped, degraded or had nothing to attribute. */
  const drainJournal = async (outcomeBeforeFallback: string): Promise<string> => {
    const recordEarlierOutcome = (): void => recordEagerBarrierOutcome(ctx, outcomeBeforeFallback);
    if (isBarrierAborted()) {
      await noteDeferredPaths();
      recordEarlierOutcome();
      return resultForModel;
    }
    let journal: ConflictPeekResult | undefined;
    try {
      journal = parseConflictPeekResult(await conflictNoticePeek(conflictExecutor, ctx, noticeTarget));
    } catch (error) {
      logger.warn(ctx, "Eager store conflict journal-drain fallback failed", { error });
      recordEarlierOutcome();
      return resultForModel;
    }
    if (journal === undefined || (journal.kind !== "completed" && journal.kind !== "timed-out")) {
      recordEarlierOutcome();
      return resultForModel;
    }
    const journalReminder = journal.reminder;
    const journalEventIds = eventIdsOf(journal.events);
    if (journalReminder === undefined || journalReminder.length === 0) {
      await releaseEvents(journalEventIds);
      recordEarlierOutcome();
      return resultForModel;
    }
    if (journalEventIds.length === 0) {
      recordEarlierOutcome();
      return resultForModel;
    }
    if (isBarrierAborted()) {
      await releaseAndNote(journalEventIds);
      recordEarlierOutcome();
      return resultForModel;
    }
    if (await acknowledgeEvents(journalEventIds) === "aborted") {
      recordEarlierOutcome();
      return resultForModel;
    }
    recordEagerBarrierOutcome(ctx, OUTCOME_JOURNAL_FALLBACK);
    return withReminder(resultForModel, journalReminder);
  };

  /** The answer when a reminder exists but the turn can no longer attribute it. */
  const syncedOrExpired = (): string => (deadline.expired ? OUTCOME_TIMEOUT : OUTCOME_SYNCED);

  /** Attributes an event set and answers with the reminder, or leaves the result alone when the turn is gone. */
  const attributeReminder = async (
    reminder: string,
    eventIds: readonly string[],
    telemetryOutcome: string,
    report: () => void,
    logAttribution = false,
  ): Promise<string> => {
    if (await acknowledgeEvents(eventIds) === "aborted") {
      report();
      return resultForModel;
    }
    recordEagerBarrierOutcome(ctx, telemetryOutcome);
    if (logAttribution) {
      try {
        logger.info(ctx, "Local-sync eager conflict barrier attributed", { eventCount: eventIds.length });
      } catch {
      }
    }
    report();
    return withReminder(resultForModel, reminder);
  };

  /** A wait that ran out of time: show what it knows when it can be attributed, otherwise read the journal. */
  const settleTimedOut = async (result: ConflictPeekResult): Promise<string> => {
    const reminder = result.reminder;
    if (reminder === undefined || reminder.length === 0 || result.events.length === 0) {
      reportBarrier(OUTCOME_TIMEOUT);
      return drainJournal(OUTCOME_TIMED_OUT);
    }
    const eventIds = eventIdsOf(result.events);
    if (isBarrierAborted()) {
      await releaseAndNote(eventIds);
      reportBarrier(OUTCOME_TIMEOUT);
      return resultForModel;
    }
    return attributeReminder(reminder, eventIds, OUTCOME_ATTRIBUTED_TIMED_OUT, () => reportBarrier(OUTCOME_TIMEOUT));
  };

  /** The store caught up: show the reminder when there is one and it can still be attributed. */
  const settleCompleted = async (result: ConflictPeekResult): Promise<string> => {
    const reminder = result.reminder;
    const eventIds = eventIdsOf(result.events);
    if (isBarrierAborted()) {
      await releaseAndNote(eventIds);
      reportBarrier(syncedOrExpired());
      return resultForModel;
    }
    if (reminder === undefined || reminder.length === 0) {
      reportBarrier(OUTCOME_SYNCED);
      return drainJournal(OUTCOME_CLEAN);
    }
    return attributeReminder(reminder, eventIds, OUTCOME_ATTRIBUTED, () => reportBarrier(OUTCOME_SYNCED), true);
  };

  /** What each kind of eager answer leaves behind. */
  const settleByKind: Record<ConflictKind, (result: ConflictPeekResult) => Promise<string>> = {
    "not-applicable": async () => {
      reportBarrier(OUTCOME_ABSENT);
      return drainJournal(OUTCOME_DEGRADED);
    },
    "mount-passive": async () => {
      reportBarrier(OUTCOME_PASSIVE);
      return drainJournal(OUTCOME_DEGRADED);
    },
    "timed-out": settleTimedOut,
    "failed": async () => {
      reportBarrier(OUTCOME_ERROR);
      return drainJournal(OUTCOME_ERROR);
    },
    "completed": settleCompleted,
  };

  /** One eager pass: ask the store to wait for a same-result conflict, then let its kind decide the answer. */
  const runEagerPass = async (): Promise<string> => {
    try {
      const answer = await conflictNoticeSyncAndPeek(conflictExecutor, ctx, {
        writtenPaths: [path],
        eager: true,
        timeoutMs: writeBarrierTimeoutMs,
        ...(noticeTarget !== undefined ? { conversationId: noticeTarget.conversationId } : {}),
      });
      const result = parseConflictPeekResult(answer);
      if (result === undefined) {
        reportBarrier(OUTCOME_ERROR);
        return drainJournal(OUTCOME_ERROR);
      }
      return await settleByKind[result.kind](result);
    } catch (error) {
      logger.warn(ctx, "Eager store conflict barrier failed", { error });
      reportBarrier(OUTCOME_ERROR);
      return drainJournal(OUTCOME_ERROR);
    }
  };

  if (!(writeBarrierTimeoutMs > 0)) {
    reportBarrier(OUTCOME_SKIPPED);
    return drainJournal(OUTCOME_DEGRADED);
  }

  /** The deadline side of the race: expire the barrier, note the write, and answer as written. */
  const waitForDeadline = (): Promise<string> =>
    delay(outerDeadlineMs).then(async () => {
      if (!claimRace("timeout")) return new Promise<string>(() => {});
      deadline.expired = true;
      await noteDeferredPaths();
      reportBarrier(OUTCOME_TIMEOUT);
      return resultForModel;
    });

  return Promise.race([
    runEagerPass().finally(() => {
      if (raceWinner === undefined) raceWinner = "eager";
    }),
    waitForDeadline(),
  ]);
}

/** Runs both after-write steps for the file that was just written, when the session asked for the barrier. */
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
