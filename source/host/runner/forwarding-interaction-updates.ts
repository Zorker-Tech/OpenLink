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

export interface ForwardedUpdate {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ForwardedTaskProgressUpdate extends ForwardedUpdate, SlateTaskProgressDelivery {
  readonly type: "task-progress"
  readonly toolCallId: string
}

export interface ForwardingInteractionObservers {
  onToolCall?: (phase: string, callId: string, toolCall: unknown) => void;
  resolveToolName?: (phase: string, callId: string, fallback: string) => string;
  onSurfaceUnresolvedPending?: (callId: string, update: ForwardedUpdate) => void;
  onSummaryLifecycle?: () => void;
}

type ToolCallPhase = "toolCallStarted" | "partialToolCall" | "toolCallCompleted";
type ToolCallProjector = (
  phase: ToolCallPhase,
  callId: string,
  toolCall: unknown,
  modelCallId: string | undefined,
  surfaceName: string,
) => unknown | null;

const SURFACE_UNRESOLVED_TOOL_CASES = new Set(["shellToolCall", "readToolCall", "awaitToolCall"]);

/** Translate agent updates into the event shapes the Slate conversation surface consumes. */
export class InteractionUpdateForwarder extends NoopInteractionListener<{ readonly canceled?: boolean }> {
  #projectToolCall: ToolCallProjector;

  constructor(
    readonly onUpdate: (event: ForwardedUpdate) => void,
    readonly observers: ForwardingInteractionObservers = {},
    projectToolCall: ToolCallProjector = () => null,
  ) {
    super();
    this.#projectToolCall = projectToolCall;
  }

  override async sendUpdate(ctx: { canceled?: boolean }, update: any): Promise<void> {
    await super.sendUpdate(ctx, update);
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
        this.forwardToolCall(message.case, message.value);
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

  private forwardToolCall(phase: ToolCallPhase, value: { callId: string; toolCall?: OutlineToolCall; modelCallId?: string }): void {
    const { callId, toolCall } = value;
    if (toolCall == null) return;

    this.observers.onToolCall?.(phase, callId, toolCall);
    const outlineName = getOutlineToolCallName(toolCall);
    const forwarded: ForwardedUpdate = {
      type: "tool-call",
      id: callId,
      name: this.observers.resolveToolName?.(phase, callId, outlineName) ?? outlineName,
      status: getOutlineToolCallStatus(phase, toolCall),
      summary: getOutlineToolCallSummary(toolCall),
      args: getToolCallActivityArgs(toolCall),
    };
    this.onUpdate(forwarded);

    const projected = this.#projectToolCall(phase, callId, toolCall, value.modelCallId, forwarded.name as string);
    if (projected != null) this.onUpdate({ type: "client-side-tool-v2", update: projected });
    if (forwarded.status === "pending" && SURFACE_UNRESOLVED_TOOL_CASES.has(forwarded.name as string)) {
      this.observers.onSurfaceUnresolvedPending?.(callId, forwarded);
    }
  }
}
