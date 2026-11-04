/** Translate Slate hook notices at the boundary where agent messages cross the wire. */

import { HookAdditionalContext as HookContextMessage } from "../proto/generated/agent/v1/hook_additional_context_pb.ts"
import type { HookContextEntry } from "../../../packages/hooks-carriers/hook-additional-context.ts"

export function fromInteropHookContextMessages(messages: readonly HookContextMessage[]): HookContextEntry[] {
  return messages.map(message => ({ event: message.hookEventName, text: message.content }))
}

export function toInteropHookContextMessages(entries: readonly HookContextEntry[]): HookContextMessage[] {
  return entries.map(entry => new HookContextMessage({
    hookEventName: entry.event,
    content: entry.text,
  }))
}
