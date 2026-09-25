/**
 * The surface a run step uses to account for prompt tokens.
 *
 * Accounting is reported, never blocking: a step calls this with everything it knows (the tools it
 * offered, the request context, the messages, the limits) and the tracker decides what to record. The
 * contract is written down here so the step and the tracker can be read independently — the step owns
 * the values, the tracker owns what they mean.
 */

import type { Context } from "../../context/context.ts"
import type { RequestContext } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import type { CoreMessageLike } from "../../redaction/message-redaction.ts"

export interface TrackPromptTokenUsageInput {
  readonly ctx: Context
  readonly mcpTools: readonly unknown[]
  readonly requestContext: RequestContext
  readonly messages: readonly CoreMessageLike[]
  readonly selectedContext: unknown
  readonly userInfoDisplayOptions: unknown
  readonly agentTokenLimit: number | undefined
  readonly readToolName: string | undefined
  readonly invocationId: string
  readonly modelInfo: unknown
  readonly featureFlags: unknown
  readonly stateHandler: {
    lastSkillCatalogBudgetStrategy?: string | undefined
  }
}

export type TrackPromptTokenUsage = (params: TrackPromptTokenUsageInput) => void
