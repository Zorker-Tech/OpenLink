/**
 * The context a hook hands back to the conversation.
 *
 * A hook that adds context is answering with text meant for the model, and that text has one hard
 * limit: past it the context is refused rather than silently trimmed, because a hook that believes it
 * contributed something should be told it did not. Empty or whitespace-only context is not context at
 * all and produces nothing.
 */

import { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.ts"

export const HOOK_ADDITIONAL_CONTEXT_MAX_CHARS = 10_000

export class HookAdditionalContextTooLargeError extends Error {
  readonly hookEventName: string
  readonly actualLength: number
  readonly maxLength: number

  constructor(params: { hookEventName: string; actualLength: number; maxLength: number }) {
    super(`Hook additional_context for ${params.hookEventName} is ${params.actualLength} chars (max ${params.maxLength}).`)
    this.name = "HookAdditionalContextTooLargeError"
    this.hookEventName = params.hookEventName
    this.actualLength = params.actualLength
    this.maxLength = params.maxLength
  }
}

function normalizeHookAdditionalContext(content: string | null | undefined): string | undefined {
  const normalized = content?.trim()
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined
}

export function createHookAdditionalContexts({ hookEventName, additionalContext }: {
  hookEventName: string
  additionalContext: string | null | undefined
}): HookAdditionalContext[] {
  const normalized = normalizeHookAdditionalContext(additionalContext)
  if (normalized === undefined) return []
  if (normalized.length > HOOK_ADDITIONAL_CONTEXT_MAX_CHARS) {
    throw new HookAdditionalContextTooLargeError({
      hookEventName,
      actualLength: normalized.length,
      maxLength: HOOK_ADDITIONAL_CONTEXT_MAX_CHARS,
    })
  }
  return [new HookAdditionalContext({ hookEventName, content: normalized })]
}

/** Adds to a collector that may not exist yet: a step with no context has no list to add to. */
export function appendHookAdditionalContexts(
  collector: HookAdditionalContext[] | undefined,
  contexts: readonly HookAdditionalContext[],
): void {
  if (collector !== undefined && contexts.length > 0) collector.push(...contexts)
}
