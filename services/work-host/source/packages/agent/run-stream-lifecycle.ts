/** Restore controls and best-effort checkpoint publication for an agent run. */

import type { Context } from "../context/context.ts"
import { SlateAgentActionKind, type SlateAgentActionKind as SlateAgentActionKindValue } from "./agent-action-state.ts"
import { createSpan } from "../context/telemetry.ts"
import type { SlateConversationState } from "./conversation-state.ts"
import {
  restoreAgentConversationState,
  type RunnerConversationState,
} from "../../adapters/interop/agent/redacted-conversation-state-adapter.ts"

const RUN_KIND_CHANGING_ACTIONS = [
  SlateAgentActionKind.USER_MESSAGE,
  SlateAgentActionKind.SUBSCRIPTION_NOTIFICATION,
  SlateAgentActionKind.GOAL_CONTINUATION,
  SlateAgentActionKind.RESUME,
  SlateAgentActionKind.EXECUTE_PLAN,
] as const

export function shouldTrackAgentTypeChange(actionKind: SlateAgentActionKindValue | undefined): boolean {
  return actionKind !== undefined && RUN_KIND_CHANGING_ACTIONS.includes(actionKind as typeof RUN_KIND_CHANGING_ACTIONS[number])
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
  readonly onStateUpdate?: ((ctx: Context, state: RunnerConversationState) => Promise<void> | void) | undefined
}

async function publishCheckpoint(
  host: RunStreamStateUpdateHost,
  context: Context,
  state: SlateConversationState,
): Promise<void> {
  using span = createSpan(context.withName("onStateUpdateWithFlush"))
  try {
    await host.blobStore.flush(span.ctx)
    const interopState = restoreAgentConversationState(state)
    await host.onStateUpdate?.(span.ctx, interopState)
  } catch {
    // Preserve the action result when checkpoint persistence fails.
  }
}

export function createRunStreamStateUpdateWithFlush(
  host: RunStreamStateUpdateHost,
): (ctx: Context, state: SlateConversationState) => Promise<void> {
  return (context, state) => publishCheckpoint(host, context, state)
}
