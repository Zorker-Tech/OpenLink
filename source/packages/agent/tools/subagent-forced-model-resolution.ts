/**
 * When a subagent's model is not the parent's to choose.
 *
 * Two arrangements pin the model: a credential or a harness that covers one model, and a request-based
 * session where the family is fixed but the user may pick within it. In the second, the user's own
 * choice wins — but only when it is a built-in model of that family, is not blocked, exists in the
 * catalogue and works in the mode the session is in. Anything else falls back to the pinned model, and
 * every decision is logged with its reason so a surprising model can be explained rather than guessed at.
 */

import { isBuiltInComposerSubagentSlug } from "./composer-subagent-resolution.ts"
import { SubagentModelForcePolicy } from "./subagent-model-policy.ts"

type ForcePolicy = (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy]

type ForcedModelLog = (args: {
  candidateModelId: string
  modelResolutionReason: string
  reasonDetails: Record<string, unknown>
}) => string

interface ResolvePinnedForceModelArgs {
  forceModelId?: string | undefined
  subagentModelForcePolicy: ForcePolicy
  isModelBlocked: (modelId: string) => boolean
  isMaxModeCompatible: (modelId: string) => Promise<boolean>
  logForcedModel: ForcedModelLog
}

export async function resolvePinnedForceModelId(args: ResolvePinnedForceModelArgs): Promise<string | undefined> {
  const { forceModelId, subagentModelForcePolicy, isModelBlocked, isMaxModeCompatible, logForcedModel } = args
  if (forceModelId !== undefined && !isModelBlocked(forceModelId) && await isMaxModeCompatible(forceModelId)) {
    return logForcedModel({
      candidateModelId: forceModelId,
      modelResolutionReason: "force_model",
      reasonDetails: { forceModelId, subagentModelForcePolicy },
    })
  }
  return undefined
}

interface TryResolveForcedSubagentModelArgs extends ResolvePinnedForceModelArgs {
  userRequestedModelId?: string | undefined
  isModelValid: (modelId: string) => boolean
}

export async function tryResolveForcedSubagentModel(args: TryResolveForcedSubagentModelArgs): Promise<string | undefined> {
  const {
    subagentModelForcePolicy,
    forceModelId,
    userRequestedModelId,
    isModelBlocked,
    isModelValid,
    isMaxModeCompatible,
    logForcedModel,
  } = args
  switch (subagentModelForcePolicy) {
    case SubagentModelForcePolicy.RequestBasedComposer: {
      if (forceModelId === undefined) return undefined
      // The user's pick only counts when it is one of the family's own models and is usable.
      const userSelectedForcedComposerModelId = userRequestedModelId !== undefined &&
          isBuiltInComposerSubagentSlug(userRequestedModelId) &&
          !isModelBlocked(userRequestedModelId) &&
          isModelValid(userRequestedModelId) &&
          await isMaxModeCompatible(userRequestedModelId)
        ? userRequestedModelId
        : undefined
      if (userSelectedForcedComposerModelId !== undefined) {
        return logForcedModel({
          candidateModelId: userSelectedForcedComposerModelId,
          modelResolutionReason: "force_model_user_composer_selection",
          reasonDetails: { forceModelId, userSelectedForcedComposerModelId, subagentModelForcePolicy },
        })
      }
      return resolvePinnedForceModelId({
        forceModelId,
        subagentModelForcePolicy,
        isModelBlocked,
        isMaxModeCompatible,
        logForcedModel,
      })
    }
    case SubagentModelForcePolicy.ParentPin:
      return resolvePinnedForceModelId({
        forceModelId,
        subagentModelForcePolicy,
        isModelBlocked,
        isMaxModeCompatible,
        logForcedModel,
      })
    case SubagentModelForcePolicy.None:
      return undefined
    default: {
      // A new policy has to be decided about rather than silently treated as no policy.
      const exhaustive = subagentModelForcePolicy
      throw new Error(`Unhandled subagent model force policy: ${String(exhaustive)}`)
    }
  }
}
