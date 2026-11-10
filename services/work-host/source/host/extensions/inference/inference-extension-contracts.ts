/** Public types for the inference capabilities a host composes. */

import type { SummarizationPromptSession } from "../../../packages/agent-summarization/summarization-handler.ts"
import type { HostInferenceOptions } from "./inference-service.ts"

export interface AgentPromptSession {
  getModelId(): string
  getExecutor(state?: unknown): unknown
}

export interface AgentPromptSessionOwner {
  createSession(
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ): AgentPromptSession
}

export interface AgentInferenceOwner extends AgentPromptSessionOwner {
  resolvePrivacyMode(): Promise<unknown> | unknown
  getAttachedMediaUrlProvider?(): unknown | undefined
  createSummarizationSession?(
    onRequestId: (requestId: string) => void,
    options?: Readonly<Record<string, unknown>>,
  ): SummarizationPromptSession
}

export interface InferenceExtensionContext {
  readonly deps: {
    readonly auth: HostInferenceOptions["auth"] & { peekAccessToken(): string | null }
    readonly experiments: HostInferenceOptions["experiments"]
    readonly settings: HostInferenceOptions["settings"]
  }
  readonly createPort: (onApplied: () => void) => AgentInferenceOwner
  readonly createWebSearch: (args: unknown) => unknown
  readonly createWebFetch: (args: unknown) => unknown
}

export interface InferenceExtensionApi {
  readonly isReady: () => Promise<boolean>
  readonly port: AgentInferenceOwner
  readonly onModelExperimentApplied: (listener: () => void) => () => void
  readonly createWebSearch: (args: unknown) => unknown
  readonly createWebFetch: (args: unknown) => unknown
}
