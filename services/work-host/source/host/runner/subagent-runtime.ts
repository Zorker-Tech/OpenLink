/**
 * Running a subagent.
 *
 * A subagent is started with its own conversation and its own tools, its work is bounded in how long it may run and
 * what it may spend, and what it produced is handed back to the parent as a result rather than as a transcript.
 */
import { deriveBackgroundSubagentTitle, formatSteerPrompt } from "./background-work.ts";
import type { SlateImageAttachment } from "../../packages/agent/context/image-attachment-contracts.ts";
import type { SlateVideoAttachment } from "../../packages/agent/context/video-attachment-contracts.ts";
import type { SlateSubagentAwaitRequest, SlateSubagentAwaitResult } from "../../packages/agent-exec/subagent-await.ts";

export interface SubagentLineage {
  readonly parentRequestId?: string;
  readonly parentAgentToolCallId?: string;
  readonly [key: string]: unknown;
}

export interface SubagentDispatchMeta {
  readonly toolCallId: string;
  readonly lineage?: SubagentLineage;
}

/** The request a subagent's own calls are made under: its tool call id, or just the role when it has no id. */
export function computeSubagentRequestId(toolCallId: string): string {
  return toolCallId.length > 0 ? `subagent:${toolCallId}` : "subagent";
}

export function subagentSteerRunOptions(dispatch: SubagentDispatchMeta): {
  readonly inferenceRequestId: string;
  readonly lineage?: SubagentLineage;
} {
  const parentToolCallPart = dispatch.toolCallId.length > 0
    ? { parentAgentToolCallId: dispatch.toolCallId }
    : {};
  return {
    inferenceRequestId: computeSubagentRequestId(dispatch.toolCallId),
    ...(dispatch.lineage == null
      ? {}
      : { lineage: { ...dispatch.lineage, ...parentToolCallPart } }),
  };
}

export interface SubagentRunResult {
  readonly text: string;
  readonly aborted: boolean;
}

export interface ComputerUseUsageSnapshot {
  readonly modelId?: string;
  readonly turnEndedCount: number;
  readonly usage?: unknown;
}

export interface SubagentRunOptions {
  readonly inferenceRequestId?: string;
  readonly lineage?: SubagentLineage;
  readonly selectedImages?: readonly SlateImageAttachment[];
  readonly selectedVideos?: readonly SlateVideoAttachment[];
}

export interface SubagentSession {
  run(prompt: string, options?: SubagentRunOptions): Promise<SubagentRunResult>;
  interrupt(reason: string): void;
  getResolvedOutline(): Promise<readonly unknown[]>;
  getObservedToolCallCount(): number;
  getActivitySnapshot(): readonly string[];
  getTranscriptPath(): string | null;
  getComputerUseUsageSnapshot?(): ComputerUseUsageSnapshot | undefined;
  getComputerUseAuditActionCounts?(): ReadonlyMap<string, number>;
}

export interface SubagentRecord {
  readonly subagentType: string;
  readonly title: string;
  readonly startedAtMs: number;
  status: "running" | "done" | "error" | "aborted";
  transcriptPath?: string;
  failureMessage?: string;
}

export interface BackgroundSubagentCompletion {
  readonly parentAgentId: string;
  readonly subagentAgentId: string;
  readonly subagentType: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly status: "completed" | "error";
  readonly result: string;
  readonly quietOrigin?: string;
}

export interface RunningSubagentInfo {
  readonly subagentId: string;
  readonly subagentType: string;
  readonly title: string;
  readonly elapsedMs: number;
  readonly toolCallCount: number;
  readonly recentActivity: readonly string[];
  readonly transcriptPath: string | null;
}

export interface SubagentRuntimeHost {
  getConversationId(): string;
  resolveBoxId(): string;
  emitAsyncTasksChanged(): void;
  computerUse: { freeWindow(subagentId: string): void };
  now?: () => number;
  onPendingWakeArmed?(event: {
    parentAgentId: string;
    kind: "subagent";
    workId: string;
    title: string;
    subagentType: string;
    quietOrigin?: string;
  }): void;
  onPendingWakeDisarmed?(event: {
    parentAgentId: string;
    kind: "subagent";
    workId: string;
  }): void;
  onComputerUseUsage?(event: {
    parentAgentId: string;
    subagentAgentId: string;
    subagentType: string;
    subagentRequestId: string;
    modelId?: string;
    outcome: "completed" | "error" | "aborted";
    durationMs: number;
    toolCallCount: number;
    turnEndedCount: number;
    usage?: unknown;
  }): void;
  actionAuditor?: { record(record: unknown): void };
  isComputerUseSubagentType?: (subagentType: string) => boolean;
  log?: (message: string) => void;
}

export interface DispatchParams {
  readonly subagentAgentId: string;
  readonly subagentType: string;
  readonly toolCallId: string;
  readonly prompt: string;
  readonly run: () => Promise<SubagentRunResult>;
  readonly lineage?: SubagentLineage;
  readonly quietOrigin?: string;
}

type RunOutcome =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "aborted" }
  | { readonly status: "error"; readonly error: string };

interface RuntimeMeta extends SubagentDispatchMeta {
  readonly parentAgentId: string;
  readonly subagentType: string;
  readonly title: string;
  readonly startedAtMs: number;
  readonly quietOrigin?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The quiet origin of a run, when it has one, as a spreadable field; absent rather than undefined otherwise. */
const quietOriginField = (quietOrigin: string | undefined): { quietOrigin?: string } =>
  quietOrigin == null ? {} : { quietOrigin };

function raceBackgroundRun(
  run: Promise<void>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<"settled" | "timeout"> {
  if (signal.aborted) {
    const reason = signal.reason;
    return Promise.reject(reason instanceof Error ? reason : new Error("Subagent await was aborted"));
  }
  if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.resolve("timeout");
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (result: "settled" | "timeout") => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error("Subagent await was aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    run.then(() => finish("settled"), () => finish("settled"));
    if (timeoutMs !== undefined) timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

function pauseForSubagentStateChange(timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error("Subagent await was aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(finish, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The dispatch of one background subagent, as the platform reports it when it starts. */
function dispatchEventOf(parentAgentId: string, request: DispatchParams) {
  return {
    parentAgentId,
    subagentAgentId: request.subagentAgentId,
    subagentType: request.subagentType,
    toolCallId: request.toolCallId,
    subagentRequestId: computeSubagentRequestId(request.toolCallId),
  };
}

export function createSubagentRuntime(host: SubagentRuntimeHost) {
  const now = host.now ?? Date.now;
  const sessions = new Map<string, SubagentSession>();
  const backgroundRuns = new Map<string, Promise<void>>();
  const dispatchMeta = new Map<string, RuntimeMeta>();
  const registry = new Map<string, SubagentRecord>();
  const outlines = new Map<string, readonly unknown[]>();
  const pendingSteers = new Map<string, string>();
  const aborting = new Set<string>();

  let onDispatched:
    | ((event: {
      parentAgentId: string;
      subagentAgentId: string;
      subagentType: string;
      toolCallId: string;
      subagentRequestId: string;
    }) => void)
    | undefined;
  let onSettled:
    | ((completion: BackgroundSubagentCompletion) => void)
    | undefined;
  let onChanged:
    | ((event: { parentAgentId: string; subagents: readonly ReturnType<typeof listSubagents>[number][] }) => void)
    | undefined;

  function emitSubagentsChanged(): void {
    onChanged?.({
      parentAgentId: host.getConversationId(),
      subagents: listSubagents(),
    });
  }

  /** Tells the host that a background subagent's pending wake is over, when there is one to tell. */
  function notifyWakeDisarmed(dispatch: RuntimeMeta | undefined, workId: string): void {
    if (dispatch == null) return;
    host.onPendingWakeDisarmed?.({
      parentAgentId: dispatch.parentAgentId,
      kind: "subagent",
      workId,
    });
  }

  /** A log line for a subagent lifecycle moment, naming the type and title when the registry knows them. */
  function logLifecycle(
    phase: "dispatched" | "settled",
    subagentId: string,
    status?: SubagentRecord["status"],
  ): void {
    const record = registry.get(subagentId);
    const label = record == null ? "" : ` [${record.subagentType}] "${record.title}"`;
    const statusLabel = status == null ? "" : ` status=${status}`;
    host.log?.(`[slate][subagent] ${phase} ${subagentId}${label}${statusLabel}`);
  }

  function dispatchBackgroundSubagent(request: DispatchParams): void {
    if (backgroundRuns.has(request.subagentAgentId)) return;

    const title = deriveBackgroundSubagentTitle(request.prompt);
    const startedAtMs = now();
    const parentAgentId = host.getConversationId();
    const dispatch: RuntimeMeta = {
      parentAgentId,
      subagentType: request.subagentType,
      toolCallId: request.toolCallId,
      title,
      startedAtMs,
      ...(request.lineage == null ? {} : { lineage: request.lineage }),
      ...quietOriginField(request.quietOrigin),
    };
    dispatchMeta.set(request.subagentAgentId, dispatch);
    registry.set(request.subagentAgentId, {
      subagentType: request.subagentType,
      title,
      startedAtMs,
      status: "running",
    });

    logLifecycle("dispatched", request.subagentAgentId);
    onDispatched?.(dispatchEventOf(parentAgentId, request));
    host.onPendingWakeArmed?.({
      parentAgentId,
      kind: "subagent",
      workId: request.subagentAgentId,
      title,
      subagentType: request.subagentType,
      ...quietOriginField(request.quietOrigin),
    });
    emitSubagentsChanged();
    host.emitAsyncTasksChanged();
    startBackgroundSubagentTurn(request.subagentAgentId, request.run);
  }

  function startBackgroundSubagentTurn(
    subagentId: string,
    runTurn: () => Promise<SubagentRunResult>,
  ): void {
    let turn: Promise<SubagentRunResult>;
    try {
      turn = runTurn();
    } catch (error) {
      turn = Promise.reject(error);
    }

    const promise = turn
      .then((result) =>
        settleBackgroundSubagentTurn(
          subagentId,
          result.aborted
            ? { status: "aborted" }
            : { status: "completed", text: result.text },
        ),
      )
      .catch((error: unknown) =>
        settleBackgroundSubagentTurn(subagentId, {
          status: "error",
          error: errorMessage(error),
        }),
      );
    backgroundRuns.set(subagentId, promise);
  }

  /** The status a finished run leaves in the registry: an explicit abort wins over what the run itself said. */
  function settledStatus(aborted: boolean, ending: RunOutcome): SubagentRecord["status"] {
    if (aborted || ending.status === "aborted") return "aborted";
    return ending.status === "completed" ? "done" : "error";
  }

  /** What a completed background run tells its parent, in the parent's words. */
  function settledResultText(ending: RunOutcome): string {
    if (ending.status === "completed") {
      return ending.text.trim().length > 0
        ? ending.text.trim()
        : "(the task finished without producing any text output)";
    }
    return ending.status === "aborted"
      ? "The background task was interrupted before it finished."
      : ending.error;
  }

  /** Reports a computerUse run's spend and what it did, and audits it when the host keeps an auditor. */
  function reportComputerUseRun(args: {
    readonly subagentAgentId: string;
    readonly meta: RuntimeMeta;
    readonly session: SubagentSession | undefined;
    readonly outcome: RunOutcome;
    readonly aborted: boolean;
  }): void {
    const { subagentAgentId: subagentId, meta: dispatch, session, outcome: ending, aborted } = args;
    const usage = session?.getComputerUseUsageSnapshot?.();
    const durationMs = Math.max(0, now() - dispatch.startedAtMs);
    host.onComputerUseUsage?.({
      parentAgentId: dispatch.parentAgentId,
      subagentAgentId: subagentId,
      subagentType: dispatch.subagentType,
      subagentRequestId: computeSubagentRequestId(dispatch.toolCallId),
      ...(usage?.modelId == null ? {} : { modelId: usage.modelId }),
      outcome: aborted || ending.status === "aborted" ? "aborted" : ending.status,
      durationMs,
      toolCallCount: session?.getObservedToolCallCount() ?? 0,
      turnEndedCount: usage?.turnEndedCount ?? 0,
      ...(usage?.usage == null ? {} : { usage: usage.usage }),
    });
    if (host.actionAuditor == null || session == null) return;
    const actionCounts: Record<string, number> = {};
    let actionCount = 0;
    for (const [kind, count] of session.getComputerUseAuditActionCounts?.() ?? []) {
      actionCounts[kind] = count;
      actionCount += count;
    }
    host.actionAuditor.record({
      agentId: host.getConversationId(),
      ...(dispatch.toolCallId.length === 0
        ? {}
        : { turnId: computeSubagentRequestId(dispatch.toolCallId) }),
      boxId: host.resolveBoxId(),
      occurredAtMs: now(),
      action: {
        kind: "computerUseSession",
        toolCallId: dispatch.toolCallId,
        actionCount,
        actionCounts,
        durationMs,
        screenshotCount: actionCounts.screenshot ?? 0,
      },
    });
  }

  /** The completion a settled background run hands its parent, when there is a parent handler to hand it to. */
  function settledCompletion(
    subagentId: string,
    dispatch: RuntimeMeta,
    ending: RunOutcome,
  ): BackgroundSubagentCompletion {
    return {
      parentAgentId: dispatch.parentAgentId,
      subagentAgentId: subagentId,
      subagentType: dispatch.subagentType,
      toolCallId: dispatch.toolCallId,
      title: dispatch.title,
      status: ending.status === "completed" ? "completed" : "error",
      result: settledResultText(ending),
      ...quietOriginField(dispatch.quietOrigin),
    };
  }

  async function settleBackgroundSubagentTurn(
    subagentId: string,
    ending: RunOutcome,
  ): Promise<void> {
    backgroundRuns.delete(subagentId);
    const pendingSteer = pendingSteers.get(subagentId);
    const session = sessions.get(subagentId);
    const dispatch = dispatchMeta.get(subagentId);

    // A steering message that arrived while the run settled starts another turn with it instead of settling.
    if (pendingSteer != null && session != null && !aborting.has(subagentId)) {
      pendingSteers.delete(subagentId);
      startBackgroundSubagentTurn(subagentId, () => {
        const prompt = formatSteerPrompt(pendingSteer);
        return dispatch == null
          ? session.run(prompt)
          : session.run(prompt, subagentSteerRunOptions(dispatch));
      });
      return;
    }

    pendingSteers.delete(subagentId);
    const aborted = aborting.delete(subagentId);
    const record = registry.get(subagentId);
    if (record != null) {
      record.status = settledStatus(aborted, ending);
      try {
        const transcriptPath = session?.getTranscriptPath();
        if (transcriptPath != null) record.transcriptPath = transcriptPath;
      } catch {}
      if (record.status === "error") {
        record.failureMessage = ending.status === "error" ? ending.error : "The background task failed."
      } else if (record.status === "aborted") {
        record.failureMessage = "The background task was interrupted before it finished."
      }
      logLifecycle("settled", subagentId, record.status);
      emitSubagentsChanged();
    }
    host.emitAsyncTasksChanged();

    if (session != null) {
      try {
        outlines.set(subagentId, await session.getResolvedOutline());
      } catch {}
    }

    host.computerUse.freeWindow(subagentId);
    sessions.delete(subagentId);
    dispatchMeta.delete(subagentId);

    if (dispatch != null && host.isComputerUseSubagentType?.(dispatch.subagentType) === true) {
      reportComputerUseRun({ subagentAgentId: subagentId, meta: dispatch, session: session, outcome: ending, aborted });
    }

    if (aborted) {
      notifyWakeDisarmed(dispatch, subagentId);
      return;
    }
    if (dispatch == null || onSettled == null) return;
    onSettled(settledCompletion(subagentId, dispatch, ending));
  }

  function buildRunningSubagentInfo(
    subagentId: string,
  ): RunningSubagentInfo | null {
    if (!backgroundRuns.has(subagentId)) return null;
    const dispatch = dispatchMeta.get(subagentId);
    if (dispatch == null) return null;
    const session = sessions.get(subagentId);
    return {
      subagentId: subagentId,
      subagentType: dispatch.subagentType,
      title: dispatch.title,
      elapsedMs: Math.max(0, now() - dispatch.startedAtMs),
      toolCallCount: session?.getObservedToolCallCount() ?? 0,
      recentActivity: session?.getActivitySnapshot() ?? [],
      transcriptPath: session?.getTranscriptPath() ?? null,
    };
  }

  function listRunningSubagents(): RunningSubagentInfo[] {
    const infos: RunningSubagentInfo[] = [];
    for (const id of backgroundRuns.keys()) {
      const info = buildRunningSubagentInfo(id);
      if (info != null) infos.push(info);
    }
    return infos;
  }

  function hasRunningToolCall(toolCallId: string): boolean {
    if (toolCallId.length === 0) return false
    for (const [subagentId, dispatch] of dispatchMeta) {
      if (dispatch.toolCallId === toolCallId && backgroundRuns.has(subagentId)) return true
    }
    return false
  }

  function getRunningSubagent(id: string): RunningSubagentInfo | null {
    return buildRunningSubagentInfo(id);
  }

  async function awaitSubagent(
    request: SlateSubagentAwaitRequest,
    signal: AbortSignal,
  ): Promise<SlateSubagentAwaitResult> {
    const timeoutMs = request.bounded
      ? Math.max(0, Math.floor(Number.isFinite(request.timeoutMs) ? request.timeoutMs : 0))
      : undefined;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      if (signal.aborted) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error("Subagent await was aborted");
      }
      const record = registry.get(request.agentId);
      if (record === undefined) return { kind: "not-found", agentId: request.agentId };

      if (record.status !== "running") {
        if (record.status === "done") {
          return {
            kind: "complete",
            agentId: request.agentId,
          transcriptPathKnown: record.transcriptPath !== undefined || request.bounded,
            ...(record.transcriptPath === undefined ? {} : { transcriptPath: record.transcriptPath }),
          };
        }
        return {
          kind: "error",
          agentId: request.agentId,
          error: record.failureMessage ?? "The subagent did not complete successfully.",
        };
      }

      const run = backgroundRuns.get(request.agentId);
      const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
      if (run !== undefined) {
        const waited = await raceBackgroundRun(run, remaining, signal);
        if (waited === "timeout") return { kind: "still-running", agentId: request.agentId };
        continue;
      }

      if (remaining === 0) return { kind: "still-running", agentId: request.agentId };
      await pauseForSubagentStateChange(Math.min(remaining ?? 10, 10), signal);
    }
  }

  /** The session of a subagent that can be steered or stopped, when there is a running one. */
  function liveSession(subagentId: string): SubagentSession | "not-running" {
    const session = sessions.get(subagentId);
    if (session == null || !backgroundRuns.has(subagentId)) return "not-running";
    return session;
  }

  function steerSubagent(
    subagentId: string,
    message: string,
  ): "ok" | "not-running" {
    const session = liveSession(subagentId);
    if (session === "not-running" || aborting.has(subagentId)) return "not-running";

    pendingSteers.set(subagentId, message);
    session.interrupt("Steering message from the parent agent.");
    return "ok";
  }

  function abortSubagent(
    subagentId: string,
  ): "ok" | "not-running" {
    const session = liveSession(subagentId);
    if (session === "not-running") return "not-running";

    aborting.add(subagentId);
    pendingSteers.delete(subagentId);
    notifyWakeDisarmed(dispatchMeta.get(subagentId), subagentId);
    host.emitAsyncTasksChanged();
    session.interrupt("Stopped by the parent agent.");
    return "ok";
  }

  function listSubagents() {
    return [...registry.entries()]
      .map(([subagentId, record]) => ({
        subagentId,
        subagentType: record.subagentType,
        title: record.title,
        status: record.status,
        startedAtMs: record.startedAtMs,
      }))
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }

  async function getSubagentOutline(id: string): Promise<readonly unknown[]> {
    const live = sessions.get(id);
    if (live != null) return live.getResolvedOutline();
    return outlines.get(id) ?? [];
  }

  function notifyBackgroundWorkSettled(completion: BackgroundSubagentCompletion): void {
    onSettled?.(completion);
  }

  function reset(): void {
    sessions.clear();
    registry.clear();
    outlines.clear();
    emitSubagentsChanged();
  }

  return {
    sessions: sessions,
    registryEntries: () => registry.entries(),
    notifyBackgroundWorkSettled,
    reset,
    isAborting: (id: string): boolean => aborting.has(id),
    isRunning: (id: string): boolean => backgroundRuns.has(id),
    dispatchBackgroundSubagent,
    startBackgroundSubagentTurn,
    listRunningSubagents,
    getRunningSubagent,
    hasRunningToolCall,
    awaitSubagent,
    steerSubagent,
    abortSubagent,
    listSubagents,
    hasSubagent: (id: string): boolean => registry.has(id),
    hasRunningSubagents(): boolean {
      return [...registry.values()].some(
        (record) => record.status === "running",
      );
    },
    getSubagentOutline,
    async drainBackgroundSubagents(): Promise<void> {
      await Promise.allSettled([...backgroundRuns.values()]);
    },
    setBackgroundSubagentHandler(
      handler: (completion: BackgroundSubagentCompletion) => void,
    ): void {
      onSettled = handler;
    },
    setBackgroundSubagentDispatchHandler(
      handler: NonNullable<typeof onDispatched>,
    ): void {
      onDispatched = handler;
    },
    setSubagentEventHandler(
      handler: NonNullable<typeof onChanged>,
    ): void {
      onChanged = handler;
    },
  };
}
