import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'

type ChatEventType = Pick<OpenLinkAgentEvent, 'type'>

export function hasPersistedUserMessage(events: readonly ChatEventType[]) {
  return events.some((event) => event.type === 'message.user')
}

export function shouldAutoStartInitialPrompt(
  run: string | undefined,
  initialPrompt: string,
  persistedEvents: readonly ChatEventType[],
) {
  return run === '1'
    && initialPrompt.trim().length > 0
    && !hasPersistedUserMessage(persistedEvents)
}
