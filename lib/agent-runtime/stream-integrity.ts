export function missingTerminalEventMessage(clientDisconnected: boolean): string {
  return clientDisconnected
    ? 'Agent request was canceled before the worker reported a terminal state'
    : 'Agent worker ended before reporting a terminal state'
}

export function isTerminalErrorEvent(event: { type?: unknown; recoverable?: unknown }): boolean {
  return event.type === 'error' && event.recoverable !== true
}

/**
 * A newly mounted browser cannot resume an old HTTP response body. If the
 * durable history ends inside a started turn, represent that disconnected
 * transport as a local terminal event instead of rebuilding an eternal
 * Working/Thinking state. The next real persisted sequence range starts far
 * above this local sequence, so reconciliation remains monotonic.
 */
export function recoverInterruptedInitialEvents(
  events: OpenLinkAgentEvent[],
  now = new Date(),
  minimumAgeMs = 10_000,
): OpenLinkAgentEvent[] {
  const lastUserIndex = events.findLastIndex((event) => event.type === 'message.user')
  if (lastUserIndex < 0) return events
  const turnEvents = events.slice(lastUserIndex + 1)
  if (!turnEvents.some((event) => event.type === 'session.started')) return events
  if (turnEvents.some((event) => event.type === 'session.completed' || isTerminalErrorEvent(event))) return events

  const lastEvent = events.at(-1)
  if (!lastEvent) return events
  const lastEventTime = Date.parse(lastEvent.timestamp)
  if (Number.isFinite(lastEventTime) && now.getTime() - lastEventTime < minimumAgeMs) return events

  const sequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), -1) + 1
  const errorId = `${lastEvent.sessionId}:disconnected-turn:${sequence}`
  return [...events, {
    version: 1,
    id: errorId,
    sequence,
    sessionId: lastEvent.sessionId,
    timestamp: now.toISOString(),
    source: lastEvent.source,
    type: 'error',
    errorId,
    message: 'Previous agent stream disconnected before reporting a terminal state',
    recoverable: false,
  }]
}
import type { OpenLinkAgentEvent } from './events'
