/**
 * What a turn looks like while it runs and after it ends.
 *
 * The observation carries what the platform reports about a turn — its activity, its usage, what it is waiting for —
 * and is updated as the turn goes, so a reader sees the same thing whether it attaches during the turn or after it.
 */
import {
  bucketClockSkewDeltaMs,
  sanitizeCrossClockDurationMs,
  SEND_DISPATCH_MAX_PLAUSIBLE_MS,
  TTFT_MAX_PLAUSIBLE_MS,
} from "./clock-skew-guard.ts";
import { MCP_TOOL_CALL_OUTLINE_NAME } from "./conversation-outline.ts";
import {
  createRealExpiryPolicy,
  type ExpiryPolicy,
} from "../extensions/scheduling.ts";
import { decodeBackgroundWorkMetadata } from "../../packages/agent-exec/background-work-metadata.ts";

export const MCP_EXEC_STALL_THRESHOLD_MS = 15 * 60 * 1_000;

/** How much of a turn's activity the observation keeps: the most recent lines, and no more. */
const RECENT_ACTIVITY_LIMIT = 24;

export interface AsyncTask {
  readonly status: "running";
  readonly kind: "subagent" | "shell" | "cloud-agent";
  readonly label: string;
  readonly id: string;
  readonly startedAtMs: number;
  readonly subagentType?: string;
  readonly detail?: string;
}

export interface ToolActivity {
  readonly name: string;
  readonly status: "pending" | "done" | "failed";
  readonly summary?: string;
}

/** One subagent a conversation's registry carries, as the observation reads it. */
type RegistrySubagent = readonly [
  string,
  {
    readonly status: string;
    readonly title: string;
    readonly startedAtMs: number;
    readonly subagentType: string;
  },
];

/** One background command a conversation's registry carries, as the observation reads it. */
type BackgroundWork = {
  readonly id: string;
  readonly state: string;
  readonly metadata?: unknown;
};

/** One stretched-away shell or cloud agent a conversation is watching, as the observation reads it. */
type WatchedEntry = readonly [
  string,
  { readonly title: string; readonly startedAtMs: number },
];

export interface TurnObservationHost {
  getConversationId(): string;
  isSubagentAborting?(id: string): boolean;
  isActiveRunInterrupted?(): boolean;
  isActiveRunCanceled?(): boolean;
  listBackgroundShellWork?(): readonly BackgroundWork[];
  cloudAgentWatchEntries?(): Iterable<WatchedEntry>;
  shellRewatchEntries?(): Iterable<WatchedEntry>;
  subagentRegistryEntries?(): Iterable<RegistrySubagent>;
}

export interface DispatchObservationInput {
  readonly conversationId: string;
  readonly hostReceiptPerfMs: number;
  readonly enterEpochMs?: number;
  readonly isFork: boolean;
  readonly traceId: string;
  readonly spanId: string;
  readonly resolveModelId: () => string;
  readonly addRunEvent: (
    name: string,
    attributes: Record<string, string>,
  ) => void;
  readonly setRunAttribute: (
    key: string,
    value: string | number | boolean,
  ) => void;
}

/** The run attributes a dispatch and its first token report their durations on. */
const SEND_DISPATCH_MS_ATTRIBUTE = "slate.send_dispatch_ms";
const SEND_DISPATCH_SKEW_ATTRIBUTE = "slate.send_dispatch_skew_reason";
const SEND_DISPATCH_HOST_MS_ATTRIBUTE = "slate.send_dispatch_host_ms";
const TTFT_MS_ATTRIBUTE = "slate.ttft_ms";
const TTFT_SKEW_ATTRIBUTE = "slate.ttft_skew_reason";

export interface TurnObservationTiming {
  readonly mcpExecStallExpiry?: ExpiryPolicy;
}

/** A request id worth carrying in an event, and nothing at all when there is none. */
const requestIdField = (requestId: string | undefined): { requestId?: string } =>
  requestId == null ? {} : { requestId };

/** The observation a conversation's runner reads a turn through, and the handlers it reports to. */
export function createTurnObservation(
  host: TurnObservationHost & {
    readonly now?: () => number;
    readonly performanceNow?: () => number;
    readonly onEvent?: (event: unknown) => void;
  },
  timing: TurnObservationTiming = {},
) {
  const now = host.now ?? Date.now;
  const performanceNow = host.performanceNow ?? (() => performance.now());
  const mcpExecStallExpiry = timing.mcpExecStallExpiry
    ?? createRealExpiryPolicy({
      ttlMs: MCP_EXEC_STALL_THRESHOLD_MS,
      name: "slate-mcp-exec-stall",
    });
  let turnStartedAt = now();
  let lastTool: string | undefined;
  let onTurnAwait: ((event: unknown) => void) | undefined;
  let onTurnRetry: ((event: unknown) => void) | undefined;
  let onFirstToken: ((event: unknown) => void) | undefined;
  let onSendDispatch: ((event: unknown) => void) | undefined;
  let onAsyncTasksChanged:
    | ((event: {
      parentAgentId: string;
      tasks: readonly AsyncTask[];
    }) => void)
    | undefined;
  let onToolCallDiagnostic: ((event: unknown) => void) | undefined;

  const recentActivity: string[] = [];
  let awaitObservationCount = 0;
  let observedToolCallCount = 0;
  const pendingAwaits = new Map<
    string,
    { readonly index: number; readonly blockUntilMs: number }
  >();

  /** Reports one turn event, when anybody is listening. */
  function reportTurnEvent(event: unknown): void {
    host.onEvent?.(event);
  }

  function turnStarted(): void {
    turnStartedAt = now();
    reportTurnEvent({ type: "turn-started", at: turnStartedAt });
  }

  function toolStarted(name: string): void {
    lastTool = name;
    recordToolActivity({ status: "pending", name });
    reportTurnEvent({ type: "tool-started", name, at: now() });
  }

  function toolCompleted(name: string, failed = false): void {
    lastTool = lastTool === name ? undefined : lastTool;
    recordToolActivity({
      status: failed ? "failed" : "done",
      name,
    });
    reportTurnEvent({ type: "tool-completed", name, at: now() });
  }

  function setToolCallDiagnosticHandler(
    handler: (event: unknown) => void,
  ): void {
    onToolCallDiagnostic = handler;
  }

  function setTurnAwaitHandler(handler: (event: unknown) => void): void {
    onTurnAwait = handler;
  }

  function setTurnRetryHandler(handler: (event: unknown) => void): void {
    onTurnRetry = handler;
  }

  function setFirstTokenHandler(handler: (event: unknown) => void): void {
    onFirstToken = handler;
  }

  function setSendDispatchHandler(handler: (event: unknown) => void): void {
    onSendDispatch = handler;
  }

  function setAsyncTasksEventHandler(handler: typeof onAsyncTasksChanged): void {
    onAsyncTasksChanged = handler;
  }

  /** One diagnostic about an MCP tool call, with the call's own fields and a request id when there is one. */
  function toolCallDiagnostic(call: { readonly toolCallId: string; readonly connector: string; readonly requestId?: string }, fields: Record<string, unknown>): Record<string, unknown> {
    return {
      connector: call.connector,
      toolCallId: call.toolCallId,
      toolName: MCP_TOOL_CALL_OUTLINE_NAME,
      ...requestIdField(call.requestId),
      ...fields,
    };
  }

  /** Arms the stall timer for one MCP call, and answers with the settle that reports how it ended. */
  function beginMcpExecObservation(call: {
    readonly toolCallId: string;
    readonly connector: string;
    readonly requestId?: string;
  }): (errorClass?: string) => void {
    const startedPerfMs = performanceNow();
    const elapsedMs = (): number => Math.round(performanceNow() - startedPerfMs);
    const stallArm = mcpExecStallExpiry.arm(call.toolCallId, () => {
      onToolCallDiagnostic?.({
        kind: "stalled",
        ...toolCallDiagnostic(call, { elapsedMs: elapsedMs() }),
      });
    });

    let settled = false;
    /** Reports how the call ended, once: a stall that was caught earlier is settled here too. */
    const settleCall = (errorClass?: string): void => {
      if (settled) return;
      settled = true;
      stallArm.dispose();
      if (errorClass === undefined) return;
      onToolCallDiagnostic?.({
        kind: "error",
        ...toolCallDiagnostic(call, {
          errorClass,
          durationMs: elapsedMs(),
        }),
      });
    };
    return settleCall;
  }

  /** How an await ended, when the run was being cancelled as it did. */
  function cancelledAwaitOutcome(): "aborted" | "clean_stop" {
    return host.isActiveRunInterrupted?.() === true
      ? "aborted"
      : "clean_stop";
  }

  /** The await outcome: a cancellation first, then a timeout, and otherwise a completed wait. */
  function awaitOutcome(awaitCall: { readonly result?: string }): "aborted" | "clean_stop" | "timeout" | "completed" {
    if (host.isActiveRunCanceled?.() === true) return cancelledAwaitOutcome();
    return awaitCall.result === "timeout" ? "timeout" : "completed";
  }

  /** The event an await reports when it completes, from what it was started as and what it came back with. */
  function awaitCompletedEvent(
    pending: { readonly index: number; readonly blockUntilMs: number } | undefined,
    blockUntilMs: number,
    awaitCall: { readonly result?: string },
  ) {
    return {
      awaitIndex: pending?.index ?? ++awaitObservationCount,
      blockUntilMs: pending?.blockUntilMs ?? blockUntilMs,
      outcome: awaitOutcome(awaitCall),
    };
  }

  function observeAwaitToolCall(
    event: "toolCallStarted" | "toolCallCompleted",
    callId: string,
    awaitCall: {
      readonly blockUntilMs?: number;
      readonly result?: string;
    },
  ): void {
    if (onTurnAwait == null) return;
    const blockUntilMs = Math.max(
      0,
      awaitCall.blockUntilMs ?? 0,
    );
    if (event === "toolCallStarted") {
      pendingAwaits.set(callId, { index: ++awaitObservationCount, blockUntilMs });
      return;
    }

    const pending = pendingAwaits.get(callId);
    pendingAwaits.delete(callId);
    onTurnAwait(awaitCompletedEvent(pending, blockUntilMs, awaitCall));
  }

  function flushPendingAwaitsOnUnwind(): void {
    const outcome = cancelledAwaitOutcome();
    if (onTurnAwait != null) {
      pendingAwaits.forEach((pending) => {
        onTurnAwait?.({
          awaitIndex: pending.index,
          blockUntilMs: pending.blockUntilMs,
          outcome,
        });
      });
    }
    pendingAwaits.clear();
    awaitObservationCount = 0;
  }

  /** One activity update as the line the snapshot shows it as. */
  function activityLine(update: ToolActivity): string {
    const summary = update.summary != null && update.summary.length > 0
      ? `: ${update.summary}`
      : "";
    return `[${update.status}] ${update.name}${summary}`;
  }

  function recordToolActivity(update: ToolActivity): void {
    if (update.status !== "pending") observedToolCallCount += 1;
    const line = activityLine(update);
    if (recentActivity.at(-1) === line) return;
    recentActivity.push(line);
    if (recentActivity.length > RECENT_ACTIVITY_LIMIT) {
      recentActivity.splice(0, recentActivity.length - RECENT_ACTIVITY_LIMIT);
    }
  }

  /** Whether a registry entry is a subagent still worth showing as a running task. */
  function isLiveSubagent(subagentId: string, record: { readonly status: string }): boolean {
    if (record.status !== "running") return false;
    return host.isSubagentAborting?.(subagentId) !== true;
  }

  /** The running subagents of this conversation, as tasks. */
  function subagentTasks(): AsyncTask[] {
    const tasks: AsyncTask[] = [];
    for (const [subagentId, record] of host.subagentRegistryEntries?.() ?? []) {
      if (!isLiveSubagent(subagentId, record)) continue;
      tasks.push({
        id: subagentId,
        kind: "subagent",
        label: record.title,
        status: "running",
        startedAtMs: record.startedAtMs,
        subagentType: record.subagentType,
        detail: record.subagentType,
      });
    }
    return tasks;
  }

  /** A background command's decoded metadata, when the work item carries any. */
  function backgroundWorkMetadata(metadata: unknown) {
    const metadataRecord = typeof metadata === "object"
      && metadata !== null
      && !Array.isArray(metadata)
      ? Object.fromEntries(Object.entries(metadata))
      : undefined;
    return decodeBackgroundWorkMetadata(metadataRecord);
  }

  /** The background commands of this conversation, as tasks, and the ids it registered. */
  function shellWorkTasks(registeredShellIds: Set<string>): AsyncTask[] {
    const tasks: AsyncTask[] = [];
    for (const work of host.listBackgroundShellWork?.() ?? []) {
      if (work.state !== "running") continue;
      registeredShellIds.add(work.id);
      const metadata = backgroundWorkMetadata(work.metadata);
      tasks.push({
        id: work.id,
        kind: "shell",
        label: metadata.title ?? `Background command ${work.id}`,
        startedAtMs: metadata.startTimeMs ?? 0,
        status: "running",
      });
    }
    return tasks;
  }

  /** Reattached shell watches that no live background command owns, as tasks. */
  function reattachedShellTasks(registeredShellIds: ReadonlySet<string>): AsyncTask[] {
    const tasks: AsyncTask[] = [];
    for (const [shellId, rewatch] of host.shellRewatchEntries?.() ?? []) {
      if (registeredShellIds.has(shellId)) continue;
      tasks.push({
        kind: "shell",
        id: shellId,
        label: rewatch.title,
        status: "running",
        startedAtMs: rewatch.startedAtMs,
        detail: "reattached after a host restart",
      });
    }
    return tasks;
  }

  /** The cloud agents this conversation is watching, as tasks. */
  function cloudAgentTasks(): AsyncTask[] {
    const tasks: AsyncTask[] = [];
    for (const [agentId, watch] of host.cloudAgentWatchEntries?.() ?? []) {
      tasks.push({
        kind: "cloud-agent",
        id: agentId,
        label: watch.title,
        status: "running",
        startedAtMs: watch.startedAtMs,
      });
    }
    return tasks;
  }

  /** Tasks are shown oldest first, and tasks that started together by their id. */
  function byStartThenId(left: AsyncTask, right: AsyncTask): number {
    return left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id);
  }

  /** The tasks a turn is waiting on, oldest first and then by id. */
  function listAsyncTasks(): AsyncTask[] {
    const registeredShellIds = new Set<string>();
    const tasks: AsyncTask[] = [];
    tasks.push(...subagentTasks());
    tasks.push(...shellWorkTasks(registeredShellIds));
    tasks.push(...reattachedShellTasks(registeredShellIds), ...cloudAgentTasks());
    return tasks.sort(byStartThenId);
  }

  function emitAsyncTasksChanged(): void {
    const parentAgentId = host.getConversationId();
    if (parentAgentId === "") {
      throw new TypeError("async-task owner conversation id is unavailable");
    }
    onAsyncTasksChanged?.({ tasks: listAsyncTasks(), parentAgentId });
  }

  /** A duration read against the wall clock, sanitized, with what the sanitizer decided about skew. */
  function sanitizeDuration(rawMs: number, maxPlausibleMs: number) {
    return sanitizeCrossClockDurationMs(rawMs, maxPlausibleMs);
  }

  /** One sanitized duration on the run: its value when it has one, and the skew reason when it does not. */
  function recordSanitizedDuration(input: DispatchObservationInput, keys: { readonly ms: string; readonly skewReason: string }, sanitized: ReturnType<typeof sanitizeCrossClockDurationMs>): void {
    if ("ms" in sanitized) input.setRunAttribute(keys.ms, sanitized.ms);
    else input.setRunAttribute(keys.skewReason, sanitized.skewReason);
  }

  /** The event a dispatch report carries, after a duration that includes the cross-clock delta was sanitized. */
  function sendDispatchEvent(input: DispatchObservationInput, args: {
    readonly sanitized: ReturnType<typeof sanitizeCrossClockDurationMs>;
    readonly hostDispatchMs: number;
    readonly rawDeltaMs: number;
  }) {
    const skew = "skewReason" in args.sanitized;
    return {
      isFork: input.isFork,
      modelId: input.resolveModelId(),
      dispatchMs: "ms" in args.sanitized ? args.sanitized.ms : undefined,
      hostDispatchMs: args.hostDispatchMs,
      skew,
      skewBucket: skew ? bucketClockSkewDeltaMs(args.rawDeltaMs) : undefined,
      skewReason: "skewReason" in args.sanitized
        ? args.sanitized.skewReason
        : undefined,
      traceId: input.traceId,
      spanId: input.spanId,
    };
  }

  /** The event a first token reports, from the duration it was measured over and what kind of chunk it was. */
  function firstTokenEvent(input: DispatchObservationInput, args: {
    readonly sanitized: ReturnType<typeof sanitizeCrossClockDurationMs>;
    readonly skew: boolean;
    readonly chunkType: string;
    readonly modelId: string | undefined;
  }) {
    return {
      chunkType: args.chunkType,
      isFork: input.isFork,
      modelId: args.modelId ?? input.resolveModelId(),
      ttftMs: "ms" in args.sanitized ? args.sanitized.ms : undefined,
      skew: args.skew,
      skewReason: "skewReason" in args.sanitized
        ? args.sanitized.skewReason
        : undefined,
      traceId: input.traceId,
      spanId: input.spanId,
    };
  }

  /** Reports how long the dispatch took, when it was entered from another clock that can be compared against this one. */
  function reportSendDispatchObservation(input: DispatchObservationInput, dispatchPerfMs: number, dispatchEpochMs: number): void {
    if (
      input.enterEpochMs === undefined
      || !Number.isFinite(input.enterEpochMs)
    ) return;
    try {
        const hostDispatchMs = Math.max(
          0,
          Math.round(
            dispatchPerfMs - input.hostReceiptPerfMs,
          ),
        );
        const rawDeltaMs = dispatchEpochMs - input.enterEpochMs;
        const sanitized = sanitizeDuration(rawDeltaMs, SEND_DISPATCH_MAX_PLAUSIBLE_MS);
        recordSanitizedDuration(input, { ms: SEND_DISPATCH_MS_ATTRIBUTE, skewReason: SEND_DISPATCH_SKEW_ATTRIBUTE }, sanitized);
        input.setRunAttribute(SEND_DISPATCH_HOST_MS_ATTRIBUTE, hostDispatchMs);
        onSendDispatch?.(sendDispatchEvent(input, { sanitized, hostDispatchMs, rawDeltaMs }));
    } catch {
      // Instrumentation failures must not alter turn execution.
    }
  }

  /** What a dispatch observation offers as a turn starts: the first token and the model a follow-up may name. */
  function createDispatchObservation(input: DispatchObservationInput) {
    let pendingFirstToken:
      | ((modelId?: string) => void)
      | undefined;
    let resolvedModelId: string | undefined;
    const dispatchPerfMs = performanceNow();
    reportSendDispatchObservation(input, dispatchPerfMs, now());

    let firstTokenObserved = false;
    const observeFirstToken = (chunkType: string): void => {
      if (firstTokenObserved) return;
      firstTokenObserved = true;
      try {
        const rawTtftMs = performanceNow() - dispatchPerfMs;
        const sanitized = sanitizeDuration(rawTtftMs, TTFT_MAX_PLAUSIBLE_MS);
        const skew = "skewReason" in sanitized;
        recordSanitizedDuration(input, { ms: TTFT_MS_ATTRIBUTE, skewReason: TTFT_SKEW_ATTRIBUTE }, sanitized);
        input.addRunEvent("first_token", {
          chunk_type: chunkType,
        });
        const emit = (modelId?: string): void => {
          onFirstToken?.(firstTokenEvent(input, { sanitized, skew, chunkType, modelId }));
        };
        if (resolvedModelId !== undefined) emit(resolvedModelId);
        else pendingFirstToken = emit;
      } catch {
        // Instrumentation failures must not alter turn execution.
      }
    };

    /** Hands the first token's event to whoever was waiting for the model id, once it is known. */
    function flushPendingFirstToken(modelId?: string): void {
      const pending = pendingFirstToken;
      pendingFirstToken = undefined;
      if (modelId !== undefined) pending?.(modelId);
      else pending?.();
    }

    return {
      observeFirstToken,
      noteModelResolved(modelId: string): void {
        resolvedModelId = modelId;
        flushPendingFirstToken(modelId);
      },
      settle(): void {
        flushPendingFirstToken();
      },
    };
  }

  /** The turn as it stands: how long it has run, and the tool it is on. */
  function turnSnapshot() {
    return {
      lastTool,
      elapsedMs: now() - turnStartedAt,
    };
  }

  /** The recent activity the turn has to show. */
  function activitySnapshot(): string[] {
    return [...recentActivity];
  }

  function observedToolCallCountValue(): number {
    return observedToolCallCount;
  }

  function reportTurnRetry(event: unknown): void {
    onTurnRetry?.(event);
  }

  function reportFirstToken(event: unknown): void {
    onFirstToken?.(event);
  }

  function reportSendDispatch(event: unknown): void {
    onSendDispatch?.(event);
  }

  return {
    turnStarted,
    toolStarted,
    toolCompleted,
    setToolCallDiagnosticHandler,
    beginMcpExecObservation,
    observeAwaitToolCall,
    cancelledAwaitOutcome,
    flushPendingAwaitsOnUnwind,
    recordToolActivity,
    armDispatchObservation: createDispatchObservation,
    emitAsyncTasksChanged,
    listAsyncTasks,
    snapshot: turnSnapshot,
    getActivitySnapshot: activitySnapshot,
    getObservedToolCallCount: observedToolCallCountValue,
    reportTurnRetry,
    emitFirstToken: reportFirstToken,
    emitSendDispatch: reportSendDispatch,
    setTurnAwaitHandler,
    setTurnRetryHandler,
    setFirstTokenHandler,
    setSendDispatchHandler,
    setAsyncTasksEventHandler,
  };
}
