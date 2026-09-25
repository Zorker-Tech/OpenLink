/**
 * The two things a run's restore has to get right, and the checkpoint it leaves behind.
 *
 * An action can change the kind of run the conversation is — a user message, a subscription
 * notification, a goal continuation, a resume, a plan execution — and the state restore has to keep that
 * marker, because losing it would make the conversation forget it is no longer the same kind of session.
 *
 * The checkpoint itself is best effort: the blob store is flushed first so what the state refers to is
 * durable before the state is handed on, and a failure in either step is swallowed here rather than
 * masking the action's own result. The state is unredacted on the way in and re-redacted on the way out,
 * because the callback's consumer expects the redacted form.
 */

import { PrivacyCapability } from "../redaction/classification.ts"
import type { Context } from "../context/context.ts"
import { createSpan } from "../context/telemetry.ts"
import { fromRedactedConversationStateStructure } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"

const AGENT_TYPE_CHANGE_ACTIONS = new Set([
  "userMessageAction",
  "subscriptionNotificationAction",
  "goalContinuationAction",
  "resumeAction",
  "executePlanAction",
])

export function shouldTrackAgentTypeChange(actionCase: string | undefined): boolean {
  return actionCase !== undefined && AGENT_TYPE_CHANGE_ACTIONS.has(actionCase)
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

/** The runner's own restore controls are added without disturbing the caller's options. */
export function buildRunStreamStateHandleOptions(
  options: RunStreamStateHandleOptions,
  featureFlags: RunStreamFeatureFlags | undefined,
): RunStreamStateHandleOptions {
  return {
    ...options,
    serializeSubagentStatesAsBlobRefs: featureFlags?.serializeSubagentStatesAsBlobRefs === true,
    restoreBlobFetchConcurrency: featureFlags?.agentStateRestoreBlobFetchConcurrency,
  }
}

export interface RunStreamStateUpdateHost {
  readonly blobStore: {
    flush(ctx: Context): Promise<unknown>
  }
  readonly onStateUpdate?: (ctx: Context, state: unknown) => Promise<void> | void
}

export function createRunStreamStateUpdateWithFlush(
  host: RunStreamStateUpdateHost,
): (ctx: Context, state: unknown) => Promise<void> {
  return async (innerCtx, state) => {
    using span = createSpan(innerCtx.withName("onStateUpdateWithFlush"))
    try {
      await host.blobStore.flush(span.ctx)
      await host.onStateUpdate?.(
        span.ctx,
        fromRedactedConversationStateStructure(state, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
      )
    } catch {
      // A checkpoint that cannot be taken must not become the action's failure.
    }
  }
}
