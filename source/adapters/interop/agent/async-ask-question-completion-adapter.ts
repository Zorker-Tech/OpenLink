import { randomUUID } from "node:crypto"
import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"
import { RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import { UserMessage } from "../proto/generated/agent/v1/agent_pb.ts"
import { toRedactedInteractionUpdate } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { fromRedactedRepositoryIndexingInfo } from "../redacted-protos/generated/agent/v1/repo_redacted.ts"
import { Updates } from "../../../packages/agent-core/interaction-updates.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { SlateConversationStep } from "../../../packages/agent/conversation-step-state.ts"
import type { SlateUserMessage } from "../../../packages/agent/user-message-state.ts"
import type { SlateSelectedContextState } from "../../../packages/agent/context/selected-context-state.ts"
import { toInteropAgentMode } from "./mode-processing-adapter.ts"
import { fromInteropUserMessage } from "./user-message-action-protocol-adapter.ts"
import { toInteropSelectedContextState } from "./selected-context-state-adapter.ts"

const FULL_ACCESS = PrivacyCapability.UNSAFE_ALWAYS_ALLOWED

export interface ContinuationMessageSource {
  readonly selectedContext?: SlateSelectedContextState
  readonly mode?: SlateUserMessage["mode"] | undefined
  readonly compatibility?: SlateUserMessage["compatibility"]
  readonly bestOfNGroupId?: unknown
  readonly tryUseBestOfNPromotion?: unknown
}

export type RedactedTurnRequestContext = Parameters<typeof fromRedactedRequestContext>[0]

export function inspectAskQuestionTurn(
  ctx: Context,
  turn: { readonly steps: readonly { get(ctx: Context): Promise<SlateConversationStep> }[] },
): Promise<{ readonly destination: "new-turn" | "current-turn"; readonly stepCount: number }> {
  const { steps } = turn
  const latest = steps.at(-1)
  if (latest === undefined) return Promise.resolve({ destination: "new-turn", stepCount: steps.length })
  return latest.get(ctx).then((step) => ({
    destination: step.kind === "tool-call" ? "current-turn" : "new-turn",
    stepCount: steps.length,
  }))
}

export function projectTurnRequestContext(requestContext: RedactedTurnRequestContext): {
  readonly requestContext: RequestContext
  readonly repositories: readonly unknown[]
} {
  return {
    requestContext: fromRedactedRequestContext(requestContext, FULL_ACCESS, undefined),
    repositories: requestContext.repositoryInfo.map((repository: unknown) =>
      fromRedactedRepositoryIndexingInfo(repository, FULL_ACCESS, undefined),
    ),
  }
}

export function createQuestionnaireContinuation(
  source: ContinuationMessageSource,
  privacyMode: PrivacyMode,
): { readonly message: UserMessage; readonly slateMessage: SlateUserMessage; readonly appendedUpdate: unknown } {
  const message = new UserMessage({
    text: "Continue with the questionnaire results.",
    messageId: randomUUID(),
    ...(source.selectedContext === undefined
      ? {}
      : { selectedContext: toInteropSelectedContextState(source.selectedContext) }),
    mode: source.mode === undefined
      ? AgentMode.UNSPECIFIED
      : source.compatibility?.legacyModeCode === undefined
        ? toInteropAgentMode(source.mode)
        : source.compatibility.legacyModeCode as UserMessage["mode"],
    isSimulatedMsg: true,
    ...(source.bestOfNGroupId === undefined ? {} : { bestOfNGroupId: source.bestOfNGroupId as string }),
    ...(source.tryUseBestOfNPromotion === undefined ? {} : { tryUseBestOfNPromotion: source.tryUseBestOfNPromotion as boolean }),
  })
  return {
    message,
    slateMessage: fromInteropUserMessage(message),
    appendedUpdate: toRedactedInteractionUpdate(Updates.userMessageAppended(message), privacyMode),
  }
}
