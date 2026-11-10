/**
 * When a subagent's model is not the parent's to choose.
 *
 * Two arrangements pin the model: a credential or a harness that covers one model, and a request-based
 * session where the family is fixed but the user may pick within it. In the second, the user's own
 * choice wins — but only when it is a built-in model of that family, is not blocked, exists in the
 * catalogue and works in the mode the session is in. Anything else falls back to the pinned model, and
 * every decision is logged with its reason so a surprising model can be explained rather than guessed at.
 */

import { isBuiltInSubagentModelId } from "./subagent-model-resolution.ts"
import { SubagentModelForcePolicy } from "./subagent-model-policy.ts"
import type { ForcedSubagentModelInput, PinnedSubagentModelPorts } from "./subagent-forced-model-contracts.ts"
import { resolveUsablePinnedModel } from "./subagent-forced-model-policy.ts"

export type { ForcedModelAudit, ForcedSubagentModelInput, PinnedSubagentModelPorts } from "./subagent-forced-model-contracts.ts"

export async function resolveForcedSubagentModel(input: ForcedSubagentModelInput): Promise<string | undefined> {
  switch (input.subagentModelForcePolicy) {
    case SubagentModelForcePolicy.RequestBasedComposer: {
      if (input.forceModelId === undefined) return undefined
      const requestedModel = input.userRequestedModelId
      const selectedAgentModel = requestedModel !== undefined
        && isBuiltInSubagentModelId(requestedModel)
        && !input.isModelBlocked(requestedModel)
        && input.isModelValid(requestedModel)
        && await input.isMaxModeCompatible(requestedModel)
        ? requestedModel
        : undefined
      if (selectedAgentModel !== undefined) {
        return input.logForcedModel({
          candidateModelId: selectedAgentModel,
          modelResolutionReason: "force_model_user_agent_selection",
          reasonDetails: {
            forceModelId: input.forceModelId,
            userSelectedForcedAgentModelId: selectedAgentModel,
            subagentModelForcePolicy: input.subagentModelForcePolicy,
          },
        })
      }
      return resolveUsablePinnedModel(input)
    }
    case SubagentModelForcePolicy.ParentPin:
      return resolveUsablePinnedModel(input)
    case SubagentModelForcePolicy.None:
      return undefined
    default: {
      const unrecognizedPolicy = input.subagentModelForcePolicy
      throw new Error(`Unhandled subagent model force policy: ${String(unrecognizedPolicy)}`)
    }
  }
}
