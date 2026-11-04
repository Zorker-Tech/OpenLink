/** Restore controls and best-effort checkpoint publication for an agent run. */

import type { Context } from "../context/context.ts"
import { createSpan } from "../context/telemetry.ts"
import { restoreAgentConversationState } from "../../adapters/interop/agent/redacted-conversation-state-adapter.ts"

const RUN_KIND_CHANGING_ACTIONS = [
  "userMessageAction",
  "subscriptionNotificationAction",
  "goalContinuationAction",
  "resumeAction",
  "executePlanAction",
] as const

export function shouldTrackAgentTypeChange(actionCase: string | undefined): boolean {
  return actionCase !== undefined && RUN_KIND_CHANGING_ACTIONS.includes(actionCase as typeof RUN_KIND_CHANGING_ACTIONS[number])
}

export interface RunStreamStateHandleOptions {
  readonly shouldTrackAgentTypeChange?: boolean
  readonly loadRootPromptBlobs?: boolean
  readonly restoreBlobFetchConcurrency?: number | undefined
  readonly serializeSubagentStatesAsBlobRefs?: boolean
  readonly onRootPromptImagePresence?: (presence: unknown) => void
}

export interface RunStreamFeatureFlags {
  readonly serializeSubagentStatesAsBlobRefs?: boolean
  readonly agentStateRestoreBlobFetchConcurrency?: number
}

export function buildRunStreamStateHandleOptions(
  options: RunStreamStateHandleOptions,
  featureFlags: RunStreamFeatureFlags | undefined,
): RunStreamStateHandleOptions {
  const restoreSettings = {
    serializeSubagentStatesAsBlobRefs: featureFlags?.serializeSubagentStatesAsBlobRefs === true,
    restoreBlobFetchConcurrency: featureFlags?.agentStateRestoreBlobFetchConcurrency,
  }
  return { ...options, ...restoreSettings }
}

export interface RunStreamStateUpdateHost {
  readonly blobStore: { flush(ctx: Context): Promise<unknown> }
  readonly onStateUpdate?: ((ctx: Context, state: unknown) => Promise<void> | void) | undefined
}

async function publishCheckpoint(
  host: RunStreamStateUpdateHost,
  context: Context,
  redactedState: unknown,
): Promise<void> {
  using span = createSpan(context.withName("onStateUpdateWithFlush"))
  try {
    await host.blobStore.flush(span.ctx)
    const state = restoreAgentConversationState(redactedState)
    await host.onStateUpdate?.(span.ctx, state)
  } catch {
    // Preserve the action result when checkpoint persistence fails.
  }
}

export function createRunStreamStateUpdateWithFlush(
  host: RunStreamStateUpdateHost,
): (ctx: Context, state: unknown) => Promise<void> {
  return (context, state) => publishCheckpoint(host, context, state)
}
