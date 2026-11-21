import { normalizeWorkHostEntry, type BotStreamUpdate } from './bot-transcript.ts'
import { pendingBotConfirmationsFromWorkHostEntries } from './bot-confirmations.ts'

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

const toolAvatarStates = new Map(Object.entries({
  searching: ['search', 'find', 'grep', 'websearch', 'websearchtoolcall', 'placessearch', 'weatherforecast', 'restaurantsearch', 'hotelsearch', 'hoteldetails', 'carrentalsearch', 'carrentaldetails', 'flightsearch', 'flightdetails', 'arrangeflights'],
  reading: ['read', 'boxread', 'externalread', 'readtoolcall', 'readfile', 'cat', 'webfetch', 'webfetchtoolcall', 'skill'],
  writing: ['write', 'writefile', 'edit', 'editfile', 'applypatch'],
  coding: ['cloudagent', 'code'],
  running: ['bash', 'exec', 'run', 'runcommand', 'shell', 'boxshell', 'shelltoolcall'],
  computing: ['computer', 'computeruse', 'computerusetoolcall', 'desktop', 'screenshot', 'requestboxhelp'],
  controlling: ['externalshell', 'externalwrite', 'copytobox', 'copyfrombox', 'copybotfile'],
  progress: ['generateimage', 'generatevideo', 'generateimagetoolcall'],
  orbit: ['callmcptool', 'getmcptools', 'searchplugins', 'installplugin'],
  sending: ['sendmessage', 'sendtoagent', 'sendimessage', 'reacttomessage', 'updateagent', 'createagent'],
  waiting: ['await', 'awaitshell', 'externalawaitshell', 'awaittoolcall', 'requestuserform'],
}).flatMap(([state, tools]) => tools.map((tool) => [tool, state] as const)))

function toolAvatarState(tool: unknown, detail?: unknown, target?: unknown): string {
  if (typeof tool !== 'string') return 'working'
  const name = tool.trim().replace(/[-_]/g, '').toLowerCase()
  if (name.startsWith('browser')) return 'reading'
  if (name.startsWith('mcp')) return 'orbit'
  if (name === 'task' && target === 'computerUse') return 'computing'
  if (/^(shell|external(shell|write)|boxshell|shelltoolcall)$/.test(name) && typeof detail === 'string' && detail.trim()) return 'writing'
  return toolAvatarStates.get(name) ?? 'working'
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

  if (channel === 'agent-upserted') {
    const agent = recordOf(payload.agent)
    if (typeof agent?.isRunning !== 'boolean') return []
    if (!agent.isRunning) return [{ type: 'avatar-state', state: null }]
    if (agent.isComposingMessage === true) return [{ type: 'avatar-state', state: 'streaming' }]
    const activity = recordOf(agent.currentActivity)
    return [{
      type: 'avatar-state',
      state: agent.isRetrying === true ? 'waiting'
        : activity?.kind === 'thinking' ? 'thinking'
        : activity?.kind === 'tool' ? toolAvatarState(activity.tool, activity.detail, activity.target) : null,
    }]
  }

  if (channel === 'transcript') {
    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'group-turn') {
      const phase = typeof payload.phase === 'string' ? payload.phase : ''
      if (phase === 'started') return [{ type: 'pending', pending: { label: 'Working', showLabel: true, state: 'working' } }]
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
      const toolName = typeof item.name === 'string' ? item.name.trim() : ''
      const label = typeof item.summary === 'string' && item.summary.trim()
        ? item.summary.trim().slice(0, 200)
        : toolName
          ? toolName.slice(0, 200)
          : 'Working'
      return [{ type: 'pending', pending: { label, showLabel: true, state: toolAvatarState(toolName) } }, update]
    }
    if (item.kind === 'thinking') return [{ type: 'pending', pending: { label: 'Thinking', showLabel: true, state: 'thinking' } }]
    return []
  }

  if (channel === 'bot-turn') {
    const phase = typeof payload.phase === 'string' ? payload.phase : ''
    if (phase === 'started') return [{ type: 'pending', pending: { label: 'Working', showLabel: true, state: 'working' } }]
    if (phase === 'status' && typeof payload.label === 'string' && payload.label.trim()) {
      const label = payload.label.trim().slice(0, 200)
      return [{ type: 'pending', pending: { label, showLabel: true, state: 'working' } }]
    }
    if (phase === 'title' && typeof payload.title === 'string' && payload.title.trim()) {
      // The worker's LLM title is a task summary, not a tool label: it replaces
      // the optimistic prompt excerpt without touching the avatar state.
      return [{ type: 'title', title: payload.title.trim().slice(0, 120) }]
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
