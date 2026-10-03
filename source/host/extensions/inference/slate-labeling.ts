/**
 * The labeling a finished turn leaves behind, and the session that runs inference on the platform's behalf.
 *
 * Follow-up classification and post-turn labeling are recorded through the backend client, best effort: a labeling
 * that failed is reported and the turn it belonged to carries on. The provider session is the one place the host asks
 * the backend how a turn should be shaped and what a finished turn was about.
 */
import type { Context } from "../../../packages/context/context.ts";
import { conversationIdKey, requestIdKey } from "../../../packages/chat-inference-proto/client.ts";
import { coreMessageToProto } from "../../../packages/chat-inference-proto/converters.ts";
import { InferenceService } from "../../../packages/proto/generated/aiserver/v1/inference_connect.ts";
import {
  AgentFollowupCategorizationRequest,
  AgentPostTurnLabelingRequest,
} from "../../../packages/proto/generated/aiserver/v1/inference_pb.ts";
import {
  createSlateCursorBackendClient,
  type SlateInferenceOptions,
} from "../../../shared/node/cursor-backend/cursor-inference.ts";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { reportHostDiagnostic } from "../../host-diagnostics.ts";

export const SLATE_AGENT_MODE = "slate-agent";
export interface LabelMessage { providerOptions?: { cursor?: { inferenceReason?: string } }; [key: string]: unknown }
export interface LabelingClient {
  recordFollowupClassification(request: AgentFollowupCategorizationRequest): Promise<unknown>;
  recordPostTurnLabeling(request: AgentPostTurnLabelingRequest): Promise<unknown>;
}
export interface PromptExecutor {
  appendMessages(messages: LabelMessage | readonly LabelMessage[]): unknown;
  getState(): unknown;
  getMessages(): readonly LabelMessage[];
  clearMessages(): void;
  stream(...args: readonly unknown[]): unknown;
}

export function createSlateLabelingClient(options: Omit<SlateInferenceOptions, "backendUrl">): LabelingClient {
  const client = createSlateCursorBackendClient(InferenceService, options) as unknown as {
    recordAgentFollowupClassification(request: AgentFollowupCategorizationRequest): Promise<unknown>;
    recordAgentPostTurnLabeling(request: AgentPostTurnLabelingRequest): Promise<unknown>;
  };
  return {
    recordFollowupClassification: (request) => client.recordAgentFollowupClassification(request),
    recordPostTurnLabeling: (request) => client.recordAgentPostTurnLabeling(request),
  };
}

function logLabelingError(label: string, error: unknown): void {
  reportHostDiagnostic({ kind: "labeling_failed", stage: label, errorClass: errorLogTag(error) });
}

const lastRequestIdByConversation = new Map<string, string>();

export function wrapExecutorWithSlateFollowupLabeling(
  executor: PromptExecutor,
  client: LabelingClient,
  modelName: string,
  recordedRequestIds = new Set<string>(),
): PromptExecutor {
  return {
    appendMessages(messages) { executor.appendMessages(messages); return this; },
    getState: () => executor.getState(),
    getMessages: () => executor.getMessages(),
    clearMessages: () => executor.clearMessages(),
    stream(...args) {
      const [ctx, invocationId, tools, options] = args as [Context, unknown, unknown, unknown];
      const result = executor.stream(ctx, invocationId, tools, options);
      try {
        const conversationId = ctx.get(conversationIdKey);
        const requestId = ctx.get(requestIdKey);
        if (conversationId == null || conversationId === "" || requestId == null || requestId === "") return result;
        const messages = executor.getMessages();
        if (messages.length === 0 || messages.some((message) => message.providerOptions?.cursor?.inferenceReason === "agent-summarization")) return result;
        const previousRequestId = lastRequestIdByConversation.get(conversationId);
        if (lastRequestIdByConversation.get(conversationId) !== requestId) lastRequestIdByConversation.set(conversationId, requestId);
        if (previousRequestId == null || previousRequestId === "" || previousRequestId === requestId || recordedRequestIds.has(requestId)) return result;
        recordedRequestIds.add(requestId);
        const request = new AgentFollowupCategorizationRequest({
          requestId,
          replyingToRequestId: previousRequestId,
          messages: messages.map((message) => coreMessageToProto(message)),
          conversationId,
          agentMode: SLATE_AGENT_MODE,
          modelName,
        });
        void client.recordFollowupClassification(request).catch((error) => logLabelingError("followup_classification", error));
      } catch (error) {
        logLabelingError("followup_classification_prepare", error);
      }
      return result;
    },
  };
}

export function wrapPromptSessionWithSlateFollowupLabeling<T extends { getModelId(): string; getExecutor(state?: unknown): PromptExecutor }>(session: T, client: LabelingClient, modelName: string) {
  const recordedRequestIds = new Set<string>();
  return {
    getModelId: () => session.getModelId(),
    getExecutor: (state?: unknown) => wrapExecutorWithSlateFollowupLabeling(session.getExecutor(state), client, modelName, recordedRequestIds),
  };
}

export function recordSlatePostTurnLabeling(client: LabelingClient, args: { conversationId: string; requestId: string; modelName: string; messages: readonly LabelMessage[] }): void {
  if (args.messages.length === 0 || args.requestId.trim() === "" || args.conversationId.trim() === "") return;
  try {
    const request = new AgentPostTurnLabelingRequest({
      requestId: args.requestId,
      messages: args.messages.map((message) => coreMessageToProto(message)),
      conversationId: args.conversationId,
      agentMode: SLATE_AGENT_MODE,
      modelName: args.modelName,
    });
    void client.recordPostTurnLabeling(request).catch((error) => logLabelingError("post_turn_labeling", error));
  } catch (error) {
    logLabelingError("post_turn_labeling_prepare", error);
  }
}
