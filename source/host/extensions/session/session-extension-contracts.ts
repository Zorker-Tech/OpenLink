/** Ports the host provides to the session extension, and the API it returns to the host. */

import type { SlateAgentSessionStore } from "./agent-session.ts"
import type { BoxHandoffService, BoxHandoffDeps, HandoffRequest, HandoffTrigger, PendingHandoff } from "./box-handoff-service.ts"
import type { ConversationSizeLimits } from "./conversation-size-limits.ts"

export interface SessionExtensionContext {
  readonly rootDir?: string | undefined
  readonly getTranscriptsDir: () => string
  readonly deps: {
    readonly settings: { getUserTimeZone(): string | undefined }
    readonly experiments: {
      pinGateOnAuthenticatedBootstrap(name: string, listener: (enabled: boolean) => void): void
      getDynamicConfig(name: string): ConversationSizeLimits
    }
  }
  readonly createStore?: ((resolveUserTimeZone: () => string | undefined) => SlateAgentSessionStore) | undefined
  readonly createHandoffDeps: () => BoxHandoffDeps
  readonly onStop?: ((fn: () => void | Promise<void>) => void) | undefined
}

export interface SessionExtensionApi {
  readonly store: SlateAgentSessionStore
  readonly transcriptsDir: () => string
  readonly conversationBlobsPath: (dbPath: string) => string
  readonly pendingHandoff: (agentId: string) => PendingHandoff | null
  readonly startHandoff: (request: HandoffRequest) => ReturnType<BoxHandoffService["start"]>
  readonly endHandoff: (agentId: string, trigger: HandoffTrigger) => Promise<void>
  readonly forgetHandoff: (agentId: string) => void
}
