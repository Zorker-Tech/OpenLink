/** Turn hook context into the short system notices shown to the model. */

import type { HookContextEntry } from "./hook-additional-context.ts"
import { HOOK_CONTEXT_MAX_CHARACTERS } from "./hook-additional-context.ts"
import { sanitizeSystemReminderContent } from "../hooks/system-reminder-sanitizing.ts"

export function renderHookContextTexts(entries: readonly HookContextEntry[]): string[] {
  return entries.map(entry => entry.text.trim()).filter(text => text.length > 0)
}

export function renderHookContextReminders(entries: readonly HookContextEntry[]): string[] {
  return renderHookContextTexts(entries)
    .map(text => `<system_reminder>\n${sanitizeSystemReminderContent(text)}\n</system_reminder>`)
}

export function appendHookContextRemindersToToolOutput(
  textParts: string[],
  resultParts: Array<{ type: "text"; text: string }>,
  entries: readonly HookContextEntry[],
): void {
  for (const text of renderHookContextReminders(entries)) {
    textParts.push(text)
    resultParts.push({ type: "text", text })
  }
}

export function renderHookContextReminder(
  text: string | null | undefined,
  onOversize?: ((actualCharacters: number, maximumCharacters: number) => void) | undefined,
): string | undefined {
  const value = text?.trim()
  if (value === undefined || value.length === 0) return undefined
  if (value.length > HOOK_CONTEXT_MAX_CHARACTERS) {
    onOversize?.(value.length, HOOK_CONTEXT_MAX_CHARACTERS)
    return undefined
  }
  return `<system_reminder>\n${sanitizeSystemReminderContent(value)}\n</system_reminder>`
}
