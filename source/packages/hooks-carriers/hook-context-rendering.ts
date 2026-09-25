/**
 * Turning carried hook context into what the model actually reads.
 *
 * Context arrives as protobuf messages so it can cross the wire, and reaches the model as text inside
 * a `<system_reminder>` block — the same shape the platform's own reminders use, which is why the
 * content is sanitized on the way in. There are two ways it lands: appended to a tool result, so the
 * model sees it next to the call that caused it, or as a reminder of its own.
 */

import type { HookAdditionalContext } from "../proto/generated/agent/v1/hook_additional_context_pb.ts"
import { sanitizeSystemReminderContent } from "../hooks/system-reminder-sanitizing.ts"
import { HOOK_ADDITIONAL_CONTEXT_MAX_CHARS } from "./hook-additional-context.ts"

export function renderHookAdditionalContextContents(
  hookAdditionalContexts: readonly HookAdditionalContext[],
): string[] {
  return hookAdditionalContexts
    .map(context => context.content.trim())
    .filter(content => content.length > 0)
}

export function renderHookAdditionalContextSystemReminders(
  hookAdditionalContexts: readonly HookAdditionalContext[],
): string[] {
  return renderHookAdditionalContextContents(hookAdditionalContexts)
    .map(content => `<system_reminder>\n${sanitizeSystemReminderContent(content)}\n</system_reminder>`)
}

export function appendHookContextRemindersToCoreToolResult(
  textParts: string[],
  toolResultContent: Array<{ type: "text"; text: string }>,
  contexts: readonly HookAdditionalContext[],
): void {
  const reminders = renderHookAdditionalContextSystemReminders(contexts)
  for (const text of reminders) {
    textParts.push(text)
    toolResultContent.push({ type: "text", text })
  }
}

/**
 * The same reminder for a single piece of content, where oversize is a caller's decision: the callback
 * is told both numbers so it can report the loss, and nothing is rendered.
 */
export function renderHookAdditionalContextSystemReminder(
  content: string | null | undefined,
  onOversize?: ((actualLength: number, maxLength: number) => void) | undefined,
): string | undefined {
  const normalized = content?.trim()
  if (!normalized) return undefined
  if (normalized.length > HOOK_ADDITIONAL_CONTEXT_MAX_CHARS) {
    onOversize?.(normalized.length, HOOK_ADDITIONAL_CONTEXT_MAX_CHARS)
    return undefined
  }
  return `<system_reminder>\n${sanitizeSystemReminderContent(normalized)}\n</system_reminder>`
}
