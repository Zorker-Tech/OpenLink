import { randomUUID } from "node:crypto";
import { computeSubagentRequestId, type SubagentLineage, type SubagentSession } from "./subagent-runtime.ts";
import type { SubagentExecutionArgs } from "../../packages/agent-exec/subagent.ts";
import type { SlateSubagentAwaitRequest, SlateSubagentAwaitResult } from "../../packages/agent-exec/subagent-await.ts";

export class SlateSubagentDispatchError extends Error {
  override readonly name = "SlateSubagentDispatchError";
}

export type SubagentAdapterArgs = SubagentExecutionArgs & {
  readonly subagentType: string;
  readonly toolCallId: string;
  readonly prompt: string;
}

export interface SubagentDispatcher {
  isRunning(id: string): boolean;
  hasRunningToolCall?(toolCallId: string): boolean;
  awaitSubagent?(request: SlateSubagentAwaitRequest, signal: AbortSignal): Promise<SlateSubagentAwaitResult>;
  allocateComputerUseWindow(id: string): unknown | null;
  freeComputerUseWindow(id: string): void;
  dispatch(args: {
    subagentAgentId: string;
    subagentType: string;
    toolCallId: string;
    prompt: string;
    lineage?: SubagentLineage;
    run(): Promise<{ text: string; aborted?: boolean }>;
  }): void;
}

export interface SubagentSessionPolicy<BackgroundReason> {
  readonly backgroundReason: BackgroundReason;
  readonly makeDispatchError: (message: string) => Error;
  readonly deriveLineage: (ctx: unknown, toolCallId: string) => SubagentLineage | undefined;
}

type LaunchReviewer = (ctx: unknown, args: SubagentAdapterArgs) => Promise<{ allowed: boolean; reason: string }>;

function adapterArgsFromExecution(args: SubagentExecutionArgs): SubagentAdapterArgs {
  return {
    ...args,
    toolCallId: args.toolCallId ?? "",
    subagentType: args.subagentType ?? "",
    prompt: args.prompt ?? "",
  }
}

/** Owns the session map and desktop reservation rules used by the runner-facing adapter. */
export class SubagentSessionCoordinator<BackgroundReason> {
  #reviewLaunch: LaunchReviewer | undefined;
  #policy: SubagentSessionPolicy<BackgroundReason>;

  readonly sessions: Map<string, SubagentSession>;
  readonly createRunner: (id: string, args: SubagentAdapterArgs) => SubagentSession;
  readonly dispatcher: SubagentDispatcher;

  constructor(
    sessions: Map<string, SubagentSession>,
    createRunner: (id: string, args: SubagentAdapterArgs) => SubagentSession,
    dispatcher: SubagentDispatcher,
    policy: SubagentSessionPolicy<BackgroundReason>,
  ) {
    this.sessions = sessions;
    this.createRunner = createRunner;
    this.dispatcher = dispatcher;
    this.#policy = policy;
  }

  setLaunchReviewer(review: LaunchReviewer): void {
    this.#reviewLaunch = review;
  }

  hasRunningToolCall(toolCallId: string): boolean {
    return toolCallId.length > 0 && this.dispatcher.hasRunningToolCall?.(toolCallId) === true;
  }

  awaitSubagent(
    request: SlateSubagentAwaitRequest,
    signal: AbortSignal,
  ): Promise<SlateSubagentAwaitResult> {
    return this.dispatcher.awaitSubagent?.(request, signal)
      ?? Promise.resolve({ kind: "not-found", agentId: request.agentId });
  }

  async createOrResumeSession(_ctx: unknown, request: SubagentExecutionArgs): Promise<string> {
    const args = adapterArgsFromExecution(request);
    const existingId = args.resumeAgentId;
    if (existingId != null && this.sessions.has(existingId)) {
      if (this.dispatcher.isRunning(existingId)) {
        throw this.#policy.makeDispatchError(
          "That background subagent is still running, so it can't be resumed yet — use MessageSubagent or StopSubagent while it runs.",
        );
      }
      return existingId;
    }

    const id = existingId ?? `subagent-${randomUUID()}`;
    const needsDesktop = this.isComputerUse(args.subagentType);
    if (needsDesktop && this.dispatcher.allocateComputerUseWindow(id) == null) {
      throw this.#policy.makeDispatchError("A computerUse subagent is already using the box's desktop. Only one can run at a time.");
    }

    try {
      this.sessions.set(id, this.createRunner(id, args));
    } catch (error) {
      if (needsDesktop) this.dispatcher.freeComputerUseWindow(id);
      throw error;
    }
    return id;
  }

  async runSession(
    ctx: unknown,
    agentId: string,
    request: SubagentExecutionArgs,
  ): Promise<
    | { status: "error"; error: string }
    | { status: "background"; backgroundReason: BackgroundReason; toolCallCount: 0 }
  > {
    const args = adapterArgsFromExecution(request);
    const runner = this.sessions.get(agentId);
    if (runner == null) return { status: "error", error: `Unknown Slate subagent: ${agentId}` };
    if (this.dispatcher.isRunning(agentId)) return { status: "error", error: "That background subagent is already running." };

    const review = await this.#reviewLaunch?.(ctx, args);
    if (review != null && !review.allowed) {
      this.releaseSession(agentId);
      return { status: "error", error: review.reason };
    }

    const lineage = this.#policy.deriveLineage(ctx, args.toolCallId);
    this.dispatcher.dispatch({
      subagentAgentId: agentId,
      subagentType: args.subagentType || "generalPurpose",
      toolCallId: args.toolCallId,
      prompt: args.prompt,
      ...(lineage == null ? {} : { lineage }),
      run: () => runner.run(args.prompt, {
        ...(args.selectedContext === undefined ? {} : {
          selectedImages: args.selectedContext.images,
          selectedVideos: args.selectedContext.videos,
        }),
        inferenceRequestId: (args.toolCallId.length > 0 ? computeSubagentRequestId(args.toolCallId) : undefined)!,
        ...(lineage == null ? {} : { lineage }),
      }),
    });
    return {
      status: "background",
      backgroundReason: this.#policy.backgroundReason,
      toolCallCount: 0,
    };
  }

  releaseSession(agentId: string): void {
    if (this.dispatcher.isRunning(agentId)) return;
    this.sessions.delete(agentId);
    this.dispatcher.freeComputerUseWindow(agentId);
  }

  private isComputerUse(subagentType: string): boolean {
    return subagentType.replace(/[-_ ]/g, "").toLowerCase() === "computeruse";
  }
}
