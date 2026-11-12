import type { OpenLinkAgentEvent } from './agent-runtime/events'

export const BOT_CONFIRMATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export interface BotConfirmationRequest {
  id: string
  title: string
  message?: string
  options?: string[]
  inputKind?: 'confirm' | 'select' | 'input' | 'editor'
  confirmationKind?: 'approval' | 'question'
}

type RequestedConfirmation = Extract<OpenLinkAgentEvent, { type: 'confirmation.requested' }>

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().slice(0, limit)
  return text || undefined
}

function confirmationOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options = [...new Set(value.flatMap((option) => {
    const text = boundedText(option, 300)
    return text ? [text] : []
  }))].slice(0, 24)
  return options.length ? options : undefined
}

/** Convert a canonical confirmation event into the bounded shape the dock can render and resolve. */
export function botConfirmationRequest(event: RequestedConfirmation): BotConfirmationRequest | null {
  if (!BOT_CONFIRMATION_ID_PATTERN.test(event.confirmationId)) return null
  const message = boundedText(event.message, 4_000)
  const options = confirmationOptions(event.options)
  const inputKind = event.inputKind === 'confirm' || event.inputKind === 'select' || event.inputKind === 'input' || event.inputKind === 'editor'
    ? event.inputKind
    : undefined
  const confirmationKind = event.confirmationKind === 'approval' || event.confirmationKind === 'question'
    ? event.confirmationKind
    : undefined
  return {
    id: event.confirmationId,
    title: boundedText(event.title, 300) || 'Confirmation needed',
    ...(message ? { message } : {}),
    ...(options ? { options } : {}),
    ...(inputKind ? { inputKind } : {}),
    ...(confirmationKind ? { confirmationKind } : {}),
  }
}

/**
 * A Bot question card is a Work-host `send-message` widget. It stays pending
 * until a later `event` entry records the answer, so reopening the Bot shows
 * the same unresolved question without a second authority.
 */
export function pendingBotConfirmationsFromWorkHostEntries(
  entries: readonly Record<string, unknown>[],
): BotConfirmationRequest[] {
  const pending = new Map<string, BotConfirmationRequest>()
  for (const entry of entries) {
    const kind = typeof entry.kind === 'string' ? entry.kind : ''
    if (kind === 'send-message') {
      if (entry.respondedValue != null || entry.widgetSkipped === true || entry.widgetDismissed === true) continue
      const message = entry.message
      if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
      const record = message as Record<string, unknown>
      if (record.type !== 'widget') continue
      const widget = record.widget
      if (widget === null || typeof widget !== 'object' || Array.isArray(widget)) continue
      const card = widget as Record<string, unknown>
      if (card.kind !== 'bot-question') continue
      const id = typeof card.id === 'string' ? card.id : ''
      if (!BOT_CONFIRMATION_ID_PATTERN.test(id)) continue
      const method = card.method === 'confirm' || card.method === 'select' || card.method === 'input' || card.method === 'editor'
        ? card.method
        : undefined
      const title = boundedText(card.title, 300) || 'Confirmation needed'
      const messageText = boundedText(card.prompt, 4_000)
      const options = confirmationOptions(card.options)
      pending.set(id, {
        id,
        title,
        ...(messageText ? { message: messageText } : {}),
        ...(options ? { options } : {}),
        ...(method ? { inputKind: method } : {}),
        confirmationKind: method === 'confirm' ? 'approval' : 'question',
      })
      continue
    }
    if (kind === 'event') {
      const event = entry.event
      if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
      const record = event as Record<string, unknown>
      if (record.type === 'confirmation-resolved' && typeof record.extensionUiId === 'string') {
        pending.delete(record.extensionUiId)
      }
    }
  }
  return [...pending.values()]
}

/** Replay the durable event log so a reopened Bot still shows unresolved approvals. */
export function pendingBotConfirmations(events: readonly OpenLinkAgentEvent[]): BotConfirmationRequest[] {
  const pending = new Map<string, BotConfirmationRequest>()
  for (const event of events) {
    if (event.type === 'confirmation.requested') {
      const request = botConfirmationRequest(event)
      if (request) pending.set(request.id, request)
    } else if (event.type === 'confirmation.resolved') {
      pending.delete(event.confirmationId)
    }
  }
  return [...pending.values()]
}
