/** Host ports consumed while composing memory services. */

import type { PromptExecutor } from "../../packages/chat-inference/base.ts"
import type { DebouncePolicy } from "../extensions/scheduling.ts"
import type { MemoryService } from "./memory-service.ts"

export interface MemoryExtensionContext {
  readonly slateRoot: string
  readonly agentsRootDir: string
  readonly debounce: DebouncePolicy
  readonly deps: {
    readonly experiments: {
      pinGateOnAuthenticatedBootstrap(name: string, listener: (enabled: boolean) => void): void
    }
    readonly inference: {
      readonly port: {
        createSession(
          onRequestId: (requestId: string) => void,
          options: { readonly modelId: string; readonly isSummarizationSession: boolean; readonly skipLabeling: boolean },
        ): { getExecutor(): PromptExecutor<Record<string, any>> }
      }
    }
    readonly telemetry: {
      readonly logs: { reportMemorySynthesis(event: unknown): void }
    }
  }
  readonly createSynthesis: (service: MemoryService) => {
    start(): void
    dispose(): void
    recordTurn?(agentId: string, exchange: unknown): void
  }
  readonly onStop: (fn: () => void) => void
}
