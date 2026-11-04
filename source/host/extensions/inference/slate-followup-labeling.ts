import type { Context } from "../../../packages/context/context.ts";
import { conversationIdKey, requestIdKey } from "../../../adapters/interop/chat-inference-proto/client.ts";
import type { LabelingClient, LabelMessage, PromptExecutor } from "./slate-labeling-contracts.ts";
import { SLATE_AGENT_MODE } from "./slate-labeling-contracts.ts";
import { reportSlateLabelingFailure } from "./slate-labeling-diagnostics.ts";

const mostRecentRequestByConversation = new Map<string, string>();

function appendOneFollowupLabel(
  executor: PromptExecutor,
  client: LabelingClient,
  modelName: string,
  context: Context,
  alreadyRecorded: Set<string>,
): void {
  const conversationId = context.get(conversationIdKey);
  const requestId = context.get(requestIdKey);
  if (conversationId == null || conversationId === "" || requestId == null || requestId === "") return;

  const messages = executor.getMessages();
  if (messages.length === 0 || messages.some((message) => message.providerOptions?.cursor?.inferenceReason === "agent-summarization")) return;

  const previousRequest = mostRecentRequestByConversation.get(conversationId);
  if (previousRequest !== requestId) mostRecentRequestByConversation.set(conversationId, requestId);
  if (previousRequest == null || previousRequest === "" || previousRequest === requestId || alreadyRecorded.has(requestId)) return;

  alreadyRecorded.add(requestId);
  const request = {
    requestId,
    replyingToRequestId: previousRequest,
    messages,
    conversationId,
    agentMode: SLATE_AGENT_MODE,
    modelName,
  };
  void client.recordFollowupClassification(request).catch((error) => reportSlateLabelingFailure("followup_classification", error));
}

export function wrapExecutorWithSlateFollowupLabeling(
  executor: PromptExecutor,
  client: LabelingClient,
  modelName: string,
  recordedRequestIds = new Set<string>(),
): PromptExecutor {
  return {
    appendMessages(messages) {
      executor.appendMessages(messages);
      return this;
    },
    getState: () => executor.getState(),
    getMessages: () => executor.getMessages(),
    clearMessages: () => executor.clearMessages(),
    stream(...args) {
      const [context, invocationId, tools, options] = args as [Context, unknown, unknown, unknown];
      const result = executor.stream(context, invocationId, tools, options);
      try {
        appendOneFollowupLabel(executor, client, modelName, context, recordedRequestIds);
      } catch (error) {
        reportSlateLabelingFailure("followup_classification_prepare", error);
      }
      return result;
    },
  };
}

export function wrapPromptSessionWithSlateFollowupLabeling<Session extends {
  getModelId(): string;
  getExecutor(state?: unknown): PromptExecutor;
}>(session: Session, client: LabelingClient, modelName: string) {
  const recordedRequestIds = new Set<string>();
  return {
    getModelId: () => session.getModelId(),
    getExecutor: (state?: unknown) => wrapExecutorWithSlateFollowupLabeling(
      session.getExecutor(state), client, modelName, recordedRequestIds,
    ),
  };
}
