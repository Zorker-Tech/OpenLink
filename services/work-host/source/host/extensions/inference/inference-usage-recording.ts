/** Keeps provider usage reporting at the host boundary without depending on a wire library. */
import type { SlateInferenceProvider } from "../../../shared/inference-router.ts"
import type { PromptExecutor } from "./slate-labeling-contracts.ts"

export type SlateInferenceUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export function usageCountsFrom(usage: Record<string, unknown>): SlateInferenceUsage {
  const counts: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  } = {}
  if (typeof usage.inputTokens === "number") counts.inputTokens = usage.inputTokens
  if (typeof usage.outputTokens === "number") counts.outputTokens = usage.outputTokens
  if (typeof usage.cacheReadTokens === "number") counts.cacheReadTokens = usage.cacheReadTokens
  if (typeof usage.cacheWriteTokens === "number") counts.cacheWriteTokens = usage.cacheWriteTokens
  return counts
}

export function wrapExecutorWithUsageRecording(
  executor: PromptExecutor,
  provider: SlateInferenceProvider,
  recordUsage: (provider: SlateInferenceProvider, usage: SlateInferenceUsage) => void,
): PromptExecutor {
  return {
    appendMessages(messages) {
      executor.appendMessages(messages)
      return this
    },
    getState: () => executor.getState(),
    getMessages: () => executor.getMessages(),
    clearMessages: () => executor.clearMessages(),
    stream(...args: readonly unknown[]) {
      const result = executor.stream(...args) as Record<string, unknown>
      const usage = result?.extendedUsage as PromiseLike<Record<string, unknown>> | undefined
      if (usage != null && typeof usage.then === "function") {
        void Promise.resolve(usage)
          .then((reported) => recordUsage(provider, usageCountsFrom(reported)))
          .catch(() => {})
      }
      return result
    },
  }
}
