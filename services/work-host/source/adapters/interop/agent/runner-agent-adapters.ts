/** Cross the host runner boundary into generated request-context, subagent, and transcript messages. */
import type { Context } from "../../../packages/context/context.ts";
import { getRootParentRequestId } from "../../../packages/agent/utils/request-scope.ts";
import { requestIdKey } from "../chat-inference-proto/client.ts";
import { type ToolCall } from "../proto/generated/agent/v1/agent_pb.ts";
import type { SubagentBackgroundReason as SlateSubagentBackgroundReason } from "../../../packages/agent-exec/subagent.ts";
import {
  RequestContext,
  RequestContextEnv,
  RequestContextResult,
  RequestContextSuccess,
} from "../proto/generated/agent/v1/request_context_exec_pb.ts";
import { projectAgentToolCallToClientSideToolV2 } from "./client-side-tool-v2-projection-adapter.ts";
import { interopToolCallFromSlateInteractionValue } from "./interaction-tool-call-adapter.ts";
import {
  InteractionUpdateForwarder,
  type ForwardedUpdate,
  type ForwardingInteractionObservers,
} from "../../../host/runner/forwarding-interaction-updates.ts";
import type { OutlineToolCall } from "../../../host/runner/conversation-outline.ts";
import { createRequestContextResult, type RequestContextProvider } from "../../../host/runner/request-context-result.ts";
import {
  SlateSubagentDispatchError,
  SubagentSessionCoordinator,
  type SubagentAdapterArgs,
  type SubagentDispatcher,
} from "../../../host/runner/subagent-session-coordinator.ts";
import type { SubagentLineage, SubagentSession } from "../../../host/runner/subagent-runtime.ts";

/** Carry the request lineage needed to connect a child run to its originating user turn. */
export function deriveSlateSubagentRequestLineage(
  context: Context,
  toolCallId: string,
): (SubagentLineage & { parentAgentToolCallId?: string }) | undefined {
  const parentRequestId = context.get(requestIdKey);
  if (parentRequestId == null || parentRequestId === "") return undefined;
  return {
    parentRequestId,
    rootParentRequestId: getRootParentRequestId(context) ?? parentRequestId,
    ...(toolCallId.length > 0 ? { parentAgentToolCallId: toolCallId } : {}),
  };
}

/** Serialize Slate's request-context source at the executor boundary. */
export class SlateRequestContextExecutor {
  constructor(
    readonly requestContext: RequestContextProvider,
    readonly includeTranscripts: boolean,
    readonly autoReviewEnforceEnabled: boolean,
    readonly resolveAgentSkills?: () => readonly unknown[],
  ) {}

  execute(_ctx?: unknown, _args?: unknown): Promise<RequestContextResult> {
    return createRequestContextResult<RequestContextResult>({
      source: this.requestContext,
      includeTranscripts: this.includeTranscripts,
      autoReviewEnforceEnabled: this.autoReviewEnforceEnabled,
      ...(this.resolveAgentSkills === undefined ? {} : { resolveAgentSkills: this.resolveAgentSkills }),
      factories: {
        result: (fields) => new RequestContextResult(fields as never),
        success: (fields) => new RequestContextSuccess(fields as never),
        context: (fields) => new RequestContext(fields as never),
        environment: (fields) => new RequestContextEnv(fields as never),
      },
    });
  }
}

/** Bind host subagent sessions to the generated background-run reason. */
export class SlateSubagentHostAdapter extends SubagentSessionCoordinator<SlateSubagentBackgroundReason> {
  constructor(
    sessions: Map<string, SubagentSession>,
    createRunner: (id: string, args: SubagentAdapterArgs) => SubagentSession,
    dispatcher: SubagentDispatcher,
  ) {
    super(sessions, createRunner, dispatcher, {
      backgroundReason: "agent-request",
      makeDispatchError: (message) => new SlateSubagentDispatchError(message),
      deriveLineage: (context, toolCallId) => deriveSlateSubagentRequestLineage(context as Context, toolCallId),
    });
  }
}

/** Project Slate tool-call values only where the existing client projection requires its adapter shape. */
export class ForwardingInteractionListener extends InteractionUpdateForwarder {
  constructor(
    onUpdate: (event: ForwardedUpdate) => void,
    observers: ForwardingInteractionObservers = {},
  ) {
    super(onUpdate, observers, (phase, callId, toolCall, modelCallId, surfaceName) =>
      projectAgentToolCallToClientSideToolV2(
        phase,
        callId,
        toolCall as ToolCall,
        modelCallId,
        surfaceName,
      ),
    (toolCall) => interopToolCallFromSlateInteractionValue(toolCall) as unknown as OutlineToolCall);
  }
}

export type { ForwardedUpdate, ForwardingInteractionObservers };
export type { RequestContextProvider };
export type { SubagentAdapterArgs, SubagentDispatcher };
export { SlateSubagentDispatchError };
