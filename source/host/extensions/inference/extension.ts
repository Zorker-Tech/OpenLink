/**
 * The inference, declared as a host extension.
 *
 * What the rest of the host gets is one port: the session owner a turn is run through, the two web tools, and a place
 * to be told when the model experiment was applied — the port is built with the very callback that tells them. A host
 * with a mock response is ready without anyone signed in, because such a turn never leaves the machine.
 */

import type { SummarizationPromptSession } from "../../../packages/agent-summarization/summarization-handler.ts";
import type { HostInferenceOptions } from "./inference-service.ts";

export interface InferenceExtensionContext {
  deps: {
    auth: HostInferenceOptions["auth"] & { peekAccessToken(): string | null };
    experiments: HostInferenceOptions["experiments"];
    settings: HostInferenceOptions["settings"];
  };
  createPort(onApplied: () => void): AgentInferenceOwner;
  createWebSearch(args: unknown): unknown;
  createWebFetch(args: unknown): unknown;
}

export interface AgentPromptSession {
  getModelId(): string;
  getExecutor(state?: unknown): unknown;
}

export interface AgentPromptSessionOwner {
  createSession(onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>): AgentPromptSession;
}

/**
 * The owner a turn is run by: the session factory, plus the privacy, media and summarization the platform's own client
 * already knows how to answer — so a caller asks here rather than rediscovering them.
 */
export interface AgentInferenceOwner extends AgentPromptSessionOwner {
  resolvePrivacyMode(): Promise<unknown> | unknown;
  getGeminiVideoAttachedMediaUrlProvider?(): unknown | undefined;
  createSummarizationSession?(onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>): SummarizationPromptSession;
}

/** A session from the owner the host was given, with the request id and options handed through as they came. */
export function createAgentPromptSession(owner: AgentPromptSessionOwner, onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>): AgentPromptSession {
  return owner.createSession(onRequestId, options);
}

export const inferenceExtension = {
  id: "inference",
  dependencies: ["auth", "experiments", "settings"] as const,
  start(context: InferenceExtensionContext) {
    const listeners = new Set<() => void>();
    // A copy is notified, so a listener that stops listening mid-notification does not disturb the others.
    const notify = (): void => {
      for (const listener of [...listeners]) listener();
    };
    return {
      /** Whether a turn can be run at all: a mock response needs nobody signed in; anything real does. */
      async isReady(): Promise<boolean> {
        return process.env.SLATE_AGENT_MOCK_RESPONSE != null || context.deps.auth.peekAccessToken() !== null;
      },
      port: context.createPort(notify),
      onModelExperimentApplied(listener: () => void): () => void {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      createWebSearch: (args: unknown): unknown => context.createWebSearch(args),
      createWebFetch: (args: unknown): unknown => context.createWebFetch(args),
    };
  },
};
