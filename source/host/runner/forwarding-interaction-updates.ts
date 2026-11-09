import { NoopInteractionListener } from "../../packages/agent-core/interaction-listener.ts";
import {
  getOutlineToolCallName,
  getOutlineToolCallStatus,
  getOutlineToolCallSummary,
  getToolCallActivityArgs,
  type OutlineToolCall,
} from "./conversation-outline.ts";
import { turnUsageFromTurnEnded, type TurnEndedUsage } from "./turn-usage.ts";
import {
  slateTaskProgressUpdateView,
  type SlateTaskProgressDelivery,
  type SlateTaskProgressUpdate,
} from "../../packages/agent/tools/task-progress-state.ts";
import { isSlateInteractionUpdate } from "../../packages/agent-core/slate-interaction-updates.ts";
import type {
  SlateInteractionToolCallValue,
  SlateToolCallUpdatePhase,
} from "../../packages/agent-core/interaction-update-contracts.ts";

export interface ForwardedUpdate {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ForwardedTaskProgressUpdate extends ForwardedUpdate, SlateTaskProgressDelivery {
  readonly type: "task-progress"
  readonly toolCallId: string
}

export interface ForwardingInteractionObservers {
  onToolCall?: (phase: SlateToolCallUpdatePhase, callId: string, toolCall: unknown) => void;
  resolveToolName?: (phase: SlateToolCallUpdatePhase, callId: string, fallback: string) => string;
  onSurfaceUnresolvedPending?: (callId: string, update: ForwardedUpdate) => void;
  onSummaryLifecycle?: () => void;
}

type InteropToolCallPhase = "toolCallStarted" | "partialToolCall" | "toolCallCompleted";
type ToolCallProjector = (
  phase: InteropToolCallPhase,
  callId: string,
  toolCall: unknown,
  modelCallId: string | undefined,
  surfaceName: string,
) => unknown | null;
type SlateToolCallOutlineProjector = (toolCall: SlateInteractionToolCallValue) => OutlineToolCall;

function slateToolCallPhaseFromInterop(phase: InteropToolCallPhase): SlateToolCallUpdatePhase {
  switch (phase) {
    case "toolCallStarted": return "started";
    case "partialToolCall": return "partial";
    case "toolCallCompleted": return "completed";
  }
}

function interopToolCallPhaseFromSlate(phase: SlateToolCallUpdatePhase): InteropToolCallPhase {
  switch (phase) {
    case "started": return "toolCallStarted";
    case "partial": return "partialToolCall";
    case "completed": return "toolCallCompleted";
  }
}

const SURFACE_UNRESOLVED_TOOL_CASES = new Set(["shellToolCall", "readToolCall", "awaitToolCall"]);

/** Translate agent updates into the event shapes the Slate conversation surface consumes. */
export class InteractionUpdateForwarder extends NoopInteractionListener<{ readonly canceled?: boolean }> {
  #projectToolCall: ToolCallProjector;
  #projectSlateToolCall: SlateToolCallOutlineProjector;

  constructor(
    readonly onUpdate: (event: ForwardedUpdate) => void,
    readonly observers: ForwardingInteractionObservers = {},
    projectToolCall: ToolCallProjector = () => null,
    projectSlateToolCall: SlateToolCallOutlineProjector = () => {
      throw new TypeError("A Slate tool-call outline adapter is required")
    },
  ) {
    super();
    this.#projectToolCall = projectToolCall;
    this.#projectSlateToolCall = projectSlateToolCall;
  }

  override async sendUpdate(ctx: { canceled?: boolean }, update: any): Promise<void> {
    await super.sendUpdate(ctx, update);
    if (isSlateInteractionUpdate(update)) {
      switch (update.kind) {
        case "text-delta":
          this.onUpdate({ type: "text-delta", text: update.text });
          return;
        case "thinking-delta":
          this.onUpdate({ type: "thinking-delta", text: update.text });
          return;
        case "turn-ended":
          this.onUpdate(update.usage === undefined
            ? { type: "turn-ended" }
            : { type: "turn-ended", usage: { ...update.usage, reasoningTokens: update.usage.reasoningTokens ?? 0 } });
          return;
        case "token-delta":
        case "thinking-completed":
        case "heartbeat":
        case "step-started":
        case "step-completed":
        case "prompt-suggestion":
        case "active-branch-change":
        case "summary":
          return;
        case "summary-started":
        case "summary-completed":
          if (!ctx.canceled) this.observers.onSummaryLifecycle?.();
          return;
        case "tool-call-update":
          if (update.toolCall !== undefined) {
            this.forwardToolCall(update.phase, {
              callId: update.callId,
              modelCallId: update.modelCallId,
              toolCall: this.#projectSlateToolCall(update.toolCall),
            });
          }
          return;
        case "tool-call-delta":
          return;
      }
    }
    const message = update.message;
    switch (message.case) {
      case "textDelta":
        this.onUpdate({ type: "text-delta", text: message.value.text });
        return;
      case "thinkingDelta":
        this.onUpdate({ type: "thinking-delta", text: message.value.text });
        return;
      case "turnEnded": {
        const usage = turnUsageFromTurnEnded(message.value as TurnEndedUsage);
        this.onUpdate(usage == null ? { type: "turn-ended" } : { type: "turn-ended", usage });
        return;
      }
      case "toolCallStarted":
      case "partialToolCall":
      case "toolCallCompleted":
        this.forwardToolCall(slateToolCallPhaseFromInterop(message.case), message.value);
        return;
      case "summaryStarted":
      case "summaryCompleted":
        if (!ctx.canceled) this.observers.onSummaryLifecycle?.();
        return;
      default:
        return;
    }
  }

  async sendTaskProgressUpdate(
    _ctx: { readonly canceled?: boolean },
    toolCallId: string,
    modelCallId: string,
    update: SlateTaskProgressUpdate,
  ): Promise<void> {
    const event: ForwardedTaskProgressUpdate = {
      type: "task-progress",
      toolCallId,
      modelCallId,
      update: slateTaskProgressUpdateView(update),
    };
    this.onUpdate(event);
  }

  private forwardToolCall(phase: SlateToolCallUpdatePhase, value: { callId: string; toolCall?: OutlineToolCall; modelCallId?: string }): void {
    const { callId, toolCall } = value;
    if (toolCall == null) return;

    const interopPhase = interopToolCallPhaseFromSlate(phase);
    this.observers.onToolCall?.(phase, callId, toolCall);
    const outlineName = getOutlineToolCallName(toolCall);
    const forwarded: ForwardedUpdate = {
      type: "tool-call",
      id: callId,
      name: this.observers.resolveToolName?.(phase, callId, outlineName) ?? outlineName,
      status: getOutlineToolCallStatus(interopPhase, toolCall),
      summary: getOutlineToolCallSummary(toolCall),
      args: getToolCallActivityArgs(toolCall),
    };
    this.onUpdate(forwarded);

    const projected = this.#projectToolCall(interopPhase, callId, toolCall, value.modelCallId, forwarded.name as string);
    if (projected != null) this.onUpdate({ type: "client-side-tool-v2", update: projected });
    if (forwarded.status === "pending" && SURFACE_UNRESOLVED_TOOL_CASES.has(forwarded.name as string)) {
      this.observers.onSurfaceUnresolvedPending?.(callId, forwarded);
    }
  }
}
