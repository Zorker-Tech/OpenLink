/** Builds the inference owner, readiness check and host notifications from the supplied ports. */

import type { InferenceExtensionApi, InferenceExtensionContext } from "./inference-extension-contracts.ts"

export function startInferenceExtension(context: InferenceExtensionContext): InferenceExtensionApi {
  const subscribers = new Set<() => void>()
  const publishExperimentApplied = (): void => {
    for (const subscriber of [...subscribers]) subscriber()
  }
  const port = context.createPort(publishExperimentApplied)

  return {
    async isReady(): Promise<boolean> {
      return process.env.SLATE_AGENT_MOCK_RESPONSE != null || context.deps.auth.peekAccessToken() !== null
    },
    port,
    onModelExperimentApplied(subscriber: () => void): () => void {
      subscribers.add(subscriber)
      return () => { subscribers.delete(subscriber) }
    },
    createWebSearch: args => context.createWebSearch(args),
    createWebFetch: args => context.createWebFetch(args),
  }
}
