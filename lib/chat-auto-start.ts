import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'

type ChatEventType = Pick<OpenLinkAgentEvent, 'type'>

const runtimeStartFailureMessage = /^Agent runtime could not start \(([A-Z0-9_]+)\); your message has been saved$/
const retryableStartFailureCodes = new Set([
  'AGENT_TIMEOUT',
  'CLOUD_COMPUTER_UNAVAILABLE',
  'COMPUTER_AGENT_UNAVAILABLE',
  'PROJECT_BACKEND_UNAVAILABLE',
  'PROVISIONING_FAILED',
])

export function isRetryableInitialPromptFailure(event: OpenLinkAgentEvent): event is Extract<OpenLinkAgentEvent, { type: 'error' }> {
  if (event.type !== 'error' || event.recoverable !== false) return false
  const match = runtimeStartFailureMessage.exec(event.message)
  return match !== null && retryableStartFailureCodes.has(match[1])
}

export function isCloudReauthorizationFailure(event: OpenLinkAgentEvent): event is Extract<OpenLinkAgentEvent, { type: 'error' }> {
  return event.type === 'error'
    && event.recoverable === false
    && /Agent runtime could not start \(CLOUD_CONNECTION_(?:REAUTH_REQUIRED|INACTIVE)\); your message has been saved/.test(event.message)
}

export function retryableInitialPromptUserMessage(
  events: readonly OpenLinkAgentEvent[],
  initialPrompt: string,
  options: { allowReauthorizationRetry?: boolean } = {},
) {
  const prompt = initialPrompt.trim().slice(0, 10_000)
  if (!prompt) return null

  const userMessage = events.find((event) => event.type === 'message.user')
  if (!userMessage || userMessage.type !== 'message.user' || userMessage.text !== prompt) return null

  const followingEvents = events.filter((event) => event.sequence > userMessage.sequence)
  if (followingEvents.length === 0) return userMessage
  if (options.allowReauthorizationRetry
    && followingEvents.length <= 10
    && followingEvents.every(isCloudReauthorizationFailure)) return userMessage
  const failure = followingEvents.length === 1 ? followingEvents[0] : undefined
  if (!failure || !isRetryableInitialPromptFailure(failure)) return null
  return userMessage
}

export function deferInitialPromptSubmission<Timer>(
  submit: () => void,
  schedule: (callback: () => void) => Timer,
  cancel: (timer: Timer) => void,
) {
  let cancelled = false
  const timer = schedule(() => {
    if (!cancelled) submit()
  })

  return () => {
    cancelled = true
    cancel(timer)
  }
}

export function hasPersistedUserMessage(events: readonly ChatEventType[]) {
  return events.some((event) => event.type === 'message.user')
}

export function shouldAutoStartInitialPrompt(
  run: string | undefined,
  initialPrompt: string,
  persistedEvents: readonly OpenLinkAgentEvent[],
) {
  return run === '1'
    && initialPrompt.trim().length > 0
    && (!hasPersistedUserMessage(persistedEvents)
      || retryableInitialPromptUserMessage(persistedEvents, initialPrompt) !== null)
}
