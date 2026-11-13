import { normalizeWorkHostEntry, type BotStreamUpdate } from './bot-transcript.ts'
import { pendingBotConfirmationsFromWorkHostEntries } from './bot-confirmations.ts'

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function activityFromTool(item: Record<string, unknown>): BotStreamUpdate | null {
  const rawId = typeof item.id === 'string' ? item.id.trim() : ''
  if (!rawId) return null
  const status = item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'done' : 'running'
  const label = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Working'
  const summary = typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim().slice(0, 2000) : undefined
  return {
    type: 'entry',
    entry: {
      kind: 'activity',
      id: `bot-tool-${rawId}`,
      timestampMs: Date.now(),
      activity: {
        label,
        status,
        tool: 'tool',
        ...(summary === undefined ? {} : { detail: summary }),
      },
    },
  }
}

/**
 * Project one Work-host Bot frame onto the Bot surface's stream vocabulary.
 *
 * The durable timeline is Work-host's transcript. Outline items are live
 * progress only; the delivered assistant message is the transcript entry. A
 * Pi dialog arrives as a widget entry, so it becomes both a timeline entry and
 * an actionable confirmation request.
 */
export function botUpdatesFromWorkHostFrame(frame: unknown): BotStreamUpdate[] {
  const record = recordOf(frame)
  if (record === null) return []
  const channel = typeof record.channel === 'string' ? record.channel : ''
  const payload = recordOf(record.payload)
  if (payload === null) return []

  if (channel === 'transcript') {
    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'group-turn') {
      const phase = typeof payload.phase === 'string' ? payload.phase : ''
      if (phase === 'started') return [{ type: 'pending', pending: { label: 'Working', showLabel: true } }]
      if (phase === 'ended') {
        const updates: BotStreamUpdate[] = [{ type: 'pending', pending: null }]
        if (payload.ok === false) updates.push({ type: 'error', message: 'BOT_GROUP_TURN_FAILED' })
        updates.push({ type: 'done' })
        return updates
      }
      return []
    }
    if (type !== 'appended' && type !== 'updated') return []
    const entry = recordOf(payload.entry)
    if (entry === null) return []
    if (entry.kind === 'event') {
      const event = recordOf(entry.event)
      if (event?.type === 'confirmation-resolved' && typeof event.extensionUiId === 'string') {
        return [{ type: 'confirmation-resolved', id: event.extensionUiId }]
      }
    }
    const updates: BotStreamUpdate[] = []
    const normalized = normalizeWorkHostEntry(entry)
    if (normalized !== null) updates.push({ type: 'entry', entry: normalized })
    if (entry.kind === 'send-message') {
      const request = pendingBotConfirmationsFromWorkHostEntries([entry])[0]
      if (request) updates.push({ type: 'confirmation', request })
    }
    return updates
  }

  if (channel === 'outline') {
    const item = recordOf(payload.item)
    if (item === null) return []
    if (item.kind === 'tool-call') {
      const update = activityFromTool(item)
      if (update === null) return []
      // The outline carries the live task label; surface it in the Bot status
      // row while the detailed tool result stays in the timeline card.
      const label = typeof item.summary === 'string' && item.summary.trim()
        ? item.summary.trim().slice(0, 200)
        : typeof item.name === 'string' && item.name.trim()
          ? item.name.trim().slice(0, 200)
          : 'Working'
      return [{ type: 'pending', pending: { label, showLabel: true } }, update]
    }
    if (item.kind === 'thinking') return [{ type: 'pending', pending: { label: 'Thinking', showLabel: true } }]
    return []
  }

  if (channel === 'bot-turn') {
    const phase = typeof payload.phase === 'string' ? payload.phase : ''
    if (phase === 'started') return [{ type: 'pending', pending: { label: 'Working', showLabel: true } }]
    if (phase === 'status' && typeof payload.label === 'string' && payload.label.trim()) {
      return [{ type: 'pending', pending: { label: payload.label.trim().slice(0, 200), showLabel: true } }]
    }
    if (phase === 'awaiting-input') return [{ type: 'pending', pending: null }]
    if (phase === 'ended') {
      const updates: BotStreamUpdate[] = [{ type: 'pending', pending: null }]
      if (payload.ok === false && typeof payload.error === 'string' && payload.error.trim()) {
        updates.push({ type: 'error', message: payload.error.trim().slice(0, 2000) })
      }
      updates.push({ type: 'done' })
      return updates
    }
    return []
  }

  if (channel === 'tray' && payload.type === 'pushed') {
    const tray = recordOf(payload.tray)
    if (tray !== null && tray.kind === 'error') {
      const detail = typeof tray.detail === 'string' && tray.detail.trim()
        ? tray.detail.trim().slice(0, 2000)
        : typeof tray.title === 'string' && tray.title.trim()
          ? tray.title.trim().slice(0, 2000)
          : 'BOT_TURN_FAILED'
      return [{ type: 'error', message: detail }, { type: 'done' }]
    }
  }

  return []
}
