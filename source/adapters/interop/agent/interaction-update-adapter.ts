/** Temporary generated-message bridge retained during staged migration of event families. */
import {
  ActiveBranchChange,
  FeedbackRequestUpdate,
  HeartbeatUpdate,
  InteractionUpdate,
  PartialToolCallUpdate,
  PromptSuggestionUpdate,
  ShellOutputDeltaUpdate,
  StepCompletedUpdate,
  StepStartedUpdate,
  SummaryCompletedUpdate,
  SummaryStartedUpdate,
  SummaryUpdate,
  TextDeltaUpdate,
  ThinkingCompletedUpdate,
  ThinkingDeltaUpdate,
  TokenDeltaUpdate,
  ToolCallCompletedUpdate,
  ToolCallDeltaUpdate,
  ToolCallStartedUpdate,
  UserMessageAppendedUpdate,
  type FeedbackRequestCategory,
  type FeedbackRequestCategoryGroup,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type { FeedbackRequestCopy } from "../../../packages/agent-core/interaction-update-contracts.ts"

function wireUpdate(caseName: InteractionUpdate["message"]["case"], value: unknown): InteractionUpdate {
  return new InteractionUpdate({ message: { case: caseName, value } } as never)
}

export const Updates = {
  textDelta(text: string): InteractionUpdate {
    return wireUpdate("textDelta", new TextDeltaUpdate({ text }))
  },
  toolCallStarted(callId: string, toolCall: ToolCallStartedUpdate["toolCall"], modelCallId: string): InteractionUpdate {
    return wireUpdate("toolCallStarted", new ToolCallStartedUpdate({ callId, ...(toolCall === undefined ? {} : { toolCall }), modelCallId }))
  },
  toolCallCompleted(
    callId: string,
    toolCall: ToolCallCompletedUpdate["toolCall"],
    modelCallId: string,
  ): InteractionUpdate {
    return wireUpdate("toolCallCompleted", new ToolCallCompletedUpdate({ callId, ...(toolCall === undefined ? {} : { toolCall }), modelCallId }))
  },
  toolCallDelta(callId: string, toolCallDelta: ToolCallDeltaUpdate["toolCallDelta"], modelCallId: string): InteractionUpdate {
    return wireUpdate("toolCallDelta", new ToolCallDeltaUpdate({ callId, ...(toolCallDelta === undefined ? {} : { toolCallDelta }), modelCallId }))
  },
  thinkingDelta(text: string, thinkingStyle: ThinkingDeltaUpdate["thinkingStyle"]): InteractionUpdate {
    return wireUpdate("thinkingDelta", new ThinkingDeltaUpdate({ text, ...(thinkingStyle === undefined ? {} : { thinkingStyle }) }))
  },
  thinkingCompleted(thinkingDurationMs: number): InteractionUpdate {
    return wireUpdate("thinkingCompleted", new ThinkingCompletedUpdate({ thinkingDurationMs }))
  },
  userMessageAppended(userMessage: UserMessageAppendedUpdate["userMessage"]): InteractionUpdate {
    return wireUpdate("userMessageAppended", new UserMessageAppendedUpdate({ ...(userMessage === undefined ? {} : { userMessage }) }))
  },
  partialToolCall(callId: string, toolCall: PartialToolCallUpdate["toolCall"], modelCallId: string): InteractionUpdate {
    return wireUpdate("partialToolCall", new PartialToolCallUpdate({ callId, ...(toolCall === undefined ? {} : { toolCall }), modelCallId }))
  },
  tokenDelta(tokens: number): InteractionUpdate {
    return wireUpdate("tokenDelta", new TokenDeltaUpdate({ tokens }))
  },
  summary(summary: string): InteractionUpdate {
    return wireUpdate("summary", new SummaryUpdate({ summary }))
  },
  summaryStarted(): InteractionUpdate {
    return wireUpdate("summaryStarted", new SummaryStartedUpdate())
  },
  heartbeat(): InteractionUpdate {
    return wireUpdate("heartbeat", new HeartbeatUpdate())
  },
  summaryCompleted(hookMessage: SummaryCompletedUpdate["hookMessage"]): InteractionUpdate {
    return wireUpdate("summaryCompleted", new SummaryCompletedUpdate({ ...(hookMessage === undefined ? {} : { hookMessage }) }))
  },
  shellOutputDelta(event: ShellOutputDeltaUpdate["event"]): InteractionUpdate {
    return wireUpdate("shellOutputDelta", new ShellOutputDeltaUpdate({ event }))
  },
  stepStarted(stepId: number): InteractionUpdate {
    return wireUpdate("stepStarted", new StepStartedUpdate({ stepId: BigInt(stepId) }))
  },
  stepCompleted(stepId: number, stepDurationMs: number): InteractionUpdate {
    return wireUpdate("stepCompleted", new StepCompletedUpdate({ stepId: BigInt(stepId), stepDurationMs: BigInt(stepDurationMs) }),)
  },
  promptSuggestion(suggestion: string): InteractionUpdate {
    return wireUpdate("promptSuggestion", new PromptSuggestionUpdate({ suggestion }))
  },
  activeBranchChange(path: string, branchName: string): InteractionUpdate {
    return wireUpdate("activeBranchChange", new ActiveBranchChange({ path, branchName }))
  },
  feedbackRequest(
    requestId: string,
    canonicalModelName: string | undefined,
    categories: readonly FeedbackRequestCategory[],
    categoryGroups: readonly FeedbackRequestCategoryGroup[] = [],
    copy: FeedbackRequestCopy = {},
  ): InteractionUpdate {
    return wireUpdate("feedbackRequest", new FeedbackRequestUpdate({
          requestId,
          ...(canonicalModelName === undefined ? {} : { canonicalModelName }),
          categories: [...categories],
          categoryGroups: [...categoryGroups],
          ...(copy.title === undefined ? {} : { title: copy.title }),
          ...(copy.negativeTitle === undefined ? {} : { negativeTitle: copy.negativeTitle }),
          ...(copy.commentPlaceholder === undefined ? {} : { commentPlaceholder: copy.commentPlaceholder }),
        }),)
  },
}
