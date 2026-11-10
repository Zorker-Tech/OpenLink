/** Declares inference's host-facing ports and preserves the small session-construction helper. */

import { startInferenceExtension } from "./inference-extension-composition.ts"
import type {
  AgentInferenceOwner,
  AgentPromptSession,
  AgentPromptSessionOwner,
  InferenceExtensionApi,
  InferenceExtensionContext,
} from "./inference-extension-contracts.ts"

export type {
  AgentInferenceOwner,
  AgentPromptSession,
  AgentPromptSessionOwner,
  InferenceExtensionApi,
  InferenceExtensionContext,
} from "./inference-extension-contracts.ts"

export function createAgentPromptSession(
  owner: AgentPromptSessionOwner,
  onRequestId: (requestId: string) => void,
  options?: Readonly<Record<string, unknown>>,
): AgentPromptSession {
  return owner.createSession(onRequestId, options)
}

export const inferenceExtension = {
  id: "inference",
  dependencies: ["auth", "experiments", "settings"] as const,
  start(context: InferenceExtensionContext): InferenceExtensionApi {
    return startInferenceExtension(context)
  },
}
