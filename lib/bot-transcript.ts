import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import type { PendingBeat, TranscriptEntry } from '@zorker/bot-demo'
import { botConfirmationRequest, type BotConfirmationRequest } from './bot-confirmations.ts'

export type BotActivityStatus = 'running' | 'done' | 'failed'

export type BotTranscriptEntry = Extract<
  TranscriptEntry,
  { kind: 'user-message' | 'agent-message' | 'activity' | 'system' | 'confirmation' }
>

export type BotStreamUpdate =
  | { type: 'pending'; pending: PendingBeat | null }
  | { type: 'entry'; entry: BotTranscriptEntry }
  | { type: 'delta'; id: string; delta: string }
  | { type: 'confirmation'; request: BotConfirmationRequest }
  | { type: 'confirmation-resolved'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function safeId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 256 || CONTROL_CHARACTERS.test(trimmed)) return fallback
  return trimmed
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Date.now()
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function activity(
  id: string,
  label: string,
  status: BotActivityStatus,
  detail?: string,
  tool?: string,
  at = Date.now(),
): BotTranscriptEntry {
  return {
    kind: 'activity',
    id,
    timestampMs: at,
    activity: {
      label,
      status,
      ...(detail ? { detail: detail.slice(0, 2000) } : {}),
      ...(tool ? { tool } : {}),
    },
  }
}

function reactionsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.flatMap((item) => {
    if (typeof item === 'string') return [item]
    if (item && typeof item === 'object' && 'emoji' in item && typeof (item as { emoji?: unknown }).emoji === 'string') {
      return [(item as { emoji: string }).emoji]
    }
    return []
  })
  return result.length ? [...new Set(result)].slice(0, 12) : undefined
}

export function normalizeWorkHostEntry(entry: Record<string, unknown>): BotTranscriptEntry | null {
  const id = safeId(entry.id, `entry-${Math.random().toString(36).slice(2)}`)
  const at = timestamp(entry.timestampMs)
  const kind = text(entry.kind)

  if (kind === 'message') {
    const content = text(entry.content)
    if (!content) return null
    const reactions = reactionsOf(entry.reactions)
    return entry.role === 'user'
      ? {
          kind: 'user-message',
          id,
          content,
          timestampMs: at,
          ...(reactions ? { reactions } : {}),
        }
      : {
          kind: 'agent-message',
          id,
          content,
          timestampMs: at,
          ...(reactions ? { reactions } : {}),
        }
  }

  if (kind === 'user-attachment') {
    const name = text(entry.file_name) || 'Attachment'
    return { kind: 'user-message', id, content: `[${name}]`, timestampMs: at }
  }

  if (kind === 'notice') {
    const label = text(entry.text) || text(entry.content) || 'Notice'
    return activity(id, label, 'done', undefined, 'notice', at)
  }

  if (kind === 'event') {
    const event = entry.event && typeof entry.event === 'object' && !Array.isArray(entry.event)
      ? entry.event as Record<string, unknown>
      : null
    if (!event) return null
    const type = text(event.type)
    if (type === 'name-changed') {
      const name = text(event.to).trim()
      return name ? { kind: 'system', id, timestampMs: at, event: { type: 'renamed', name } } : null
    }
    if (type === 'channel-connected' || type === 'channel-disconnected') {
      const name = text(event.label).trim()
      return name
        ? {
            kind: 'system',
            id,
            timestampMs: at,
            event: { type: 'channel-changed', action: type === 'channel-connected' ? 'connected' : 'disconnected', name },
          }
        : null
    }
    // Migration bookkeeping is not part of the visible timeline.
    if (type === 'legacy-migration-complete') return null
    if (type === 'automation-changed') {
      const name = text(event.automationName).trim()
      const action = text(event.action).trim()
      if (!name || !action) return null
      if (action === 'created') {
        return { kind: 'system', id, timestampMs: at, event: { type: 'created-routine', name, triggerDescription: '' } }
      }
      return {
        kind: 'system',
        id,
        timestampMs: at,
        event: { type: 'routine-changed', name, action: action.charAt(0).toUpperCase() + action.slice(1) },
      }
    }
    return activity(id, text(event.type) || 'Updated this conversation', 'done', undefined, 'event', at)
  }

  if (kind !== 'send-message') return null
  const message = entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message)
    ? entry.message as Record<string, unknown>
    : null
  if (!message) return null
  const type = text(message.type)

  if (type === 'bot-activity') {
    const value = message.activity && typeof message.activity === 'object' && !Array.isArray(message.activity)
      ? message.activity as Record<string, unknown>
      : null
    const label = text(value?.label) || 'Working'
    const status = value?.status === 'failed' || value?.status === 'done' || value?.status === 'running'
      ? value.status
      : 'done'
    return activity(
      id,
      label,
      status,
      text(value?.detail) || undefined,
      text(value?.tool) || undefined,
      at,
    )
  }

  if (type === 'text') {
    const content = text(message.content)
    if (!content) return null
    const reactions = reactionsOf(entry.reactions)
    const author = entry.author && typeof entry.author === 'object' && !Array.isArray(entry.author)
      ? entry.author as Record<string, unknown>
      : null
    const authorId = text(author?.id).trim()
    const authorName = text(author?.name).trim()
    return {
      kind: 'agent-message',
      id,
      content,
      timestampMs: at,
      ...(authorId && authorName ? { author: { id: authorId, name: authorName } } : {}),
      ...(reactions ? { reactions } : {}),
    }
  }

  if (type === 'image' || type === 'attachment') {
    const label = text(message.file_name) || text(message.alt) || 'Attachment'
    return { kind: 'agent-message', id, content: `[${label}]`, timestampMs: at }
  }

  if (type === 'widget') {
    const widget = message.widget && typeof message.widget === 'object' && !Array.isArray(message.widget)
      ? message.widget as Record<string, unknown>
      : null
    if (widget?.kind === 'bot-question') {
      const confirmationId = text(widget.id).trim()
      if (!confirmationId) return null
      const method = widget.method === 'confirm' || widget.method === 'select' || widget.method === 'input' || widget.method === 'editor'
        ? widget.method
        : undefined
      const options = Array.isArray(widget.options)
        ? widget.options.flatMap((option) => {
            const value = text(option).trim()
            return value ? [value] : []
          }).slice(0, 24)
        : []
      return {
        kind: 'confirmation',
        id,
        timestampMs: at,
        confirmation: {
          id: confirmationId,
          title: text(widget.title).trim() || 'Confirmation needed',
          ...(text(widget.prompt).trim() ? { message: text(widget.prompt).trim().slice(0, 4_000) } : {}),
          ...(options.length ? { options } : {}),
          ...(method ? { inputKind: method } : {}),
          status: entry.respondedValue != null ? 'answered' : 'pending',
        },
      }
    }
    return activity(id, text(message.prompt) || 'Question', 'done', undefined, 'widget', at)
  }

  return activity(id, type || 'Message', 'done', undefined, type, at)
}

export function normalizeWorkHostTranscript(entries: readonly Record<string, unknown>[]): BotTranscriptEntry[] {
  // A resolved question is a later event entry, so the card's status is a
  // projection of the whole transcript, not of the widget entry alone.
  const resolved = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'event') continue
    const event = entry.event && typeof entry.event === 'object' && !Array.isArray(entry.event)
      ? entry.event as Record<string, unknown>
      : null
    if (event?.type === 'confirmation-resolved' && typeof event.extensionUiId === 'string') {
      resolved.add(event.extensionUiId)
    }
  }
  return entries.flatMap((entry) => {
    const normalized = normalizeWorkHostEntry(entry)
    if (!normalized) return []
    if (normalized.kind === 'confirmation' && resolved.has(normalized.confirmation.id)) {
      return [{ ...normalized, confirmation: { ...normalized.confirmation, status: 'answered' as const } }]
    }
    return [normalized]
  })
}

export function toWorkHostEntry(entry: BotTranscriptEntry): Record<string, unknown> {
  const id = safeId(entry.id, `entry-${Math.random().toString(36).slice(2)}`)
  const at = timestamp(entry.timestampMs)
  if (entry.kind === 'user-message') {
    return { id, kind: 'message', role: 'user', content: entry.content, timestampMs: at }
  }
  if (entry.kind === 'agent-message') {
    return {
      id,
      kind: 'send-message',
      message: { type: 'text', content: entry.content },
      ...(entry.author ? { author: entry.author } : {}),
      timestampMs: at,
    }
  }
  if (entry.kind === 'system') {
    const event = entry.event
    if (event.type === 'renamed') {
      return { id, kind: 'event', event: { type: 'name-changed', to: event.name }, timestampMs: at }
    }
    if (event.type === 'created-routine') {
      return {
        id,
        kind: 'event',
        event: { type: 'automation-changed', action: 'created', automationName: event.name },
        timestampMs: at,
      }
    }
    if (event.type === 'routine-changed') {
      return {
        id,
        kind: 'event',
        event: {
          type: 'automation-changed',
          action: event.action.toLowerCase(),
          automationName: event.name,
        },
        timestampMs: at,
      }
    }
    if (event.type === 'channel-changed') {
      return {
        id,
        kind: 'event',
        event: {
          type: event.action === 'connected' ? 'channel-connected' : 'channel-disconnected',
          label: event.name,
        },
        timestampMs: at,
      }
    }
    return { id, kind: 'event', event: { type: 'memory-updated' }, timestampMs: at }
  }
  if (entry.kind === 'confirmation') {
    return {
      id,
      kind: 'send-message',
      message: {
        type: 'widget',
        widget: {
          kind: 'bot-question',
          id: entry.confirmation.id,
          title: entry.confirmation.title,
          ...(entry.confirmation.message ? { prompt: entry.confirmation.message } : {}),
          ...(entry.confirmation.options ? { options: entry.confirmation.options } : {}),
          ...(entry.confirmation.inputKind ? { method: entry.confirmation.inputKind } : {}),
        },
      },
      timestampMs: at,
    }
  }
  return {
    id,
    kind: 'send-message',
    message: {
      type: 'bot-activity',
      activity: {
        label: entry.activity.label,
        status: entry.activity.status,
        ...(entry.activity.detail ? { detail: entry.activity.detail } : {}),
        ...(entry.activity.tool ? { tool: entry.activity.tool } : {}),
      },
    },
    timestampMs: at,
  }
}

/** Restore a group entry from its durable JSON projection. */
export function fromDurableGroupEntry(payload: unknown): BotTranscriptEntry | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const kind = text(record.kind)
  const id = safeId(record.id, '')
  const timestampMs = timestamp(record.timestampMs)
  if (!id) return null
  if (kind === 'user-message') {
    const content = text(record.content)
    return content ? { kind, id, content, timestampMs } : null
  }
  if (kind === 'agent-message') {
    const content = text(record.content)
    if (!content) return null
    const author = record.author && typeof record.author === 'object' && !Array.isArray(record.author)
      ? record.author as Record<string, unknown>
      : null
    const authorId = text(author?.id).trim()
    const authorName = text(author?.name).trim()
    return {
      kind,
      id,
      content,
      timestampMs,
      ...(authorId && authorName ? { author: { id: authorId, name: authorName } } : {}),
    }
  }
  if (kind === 'activity') {
    const value = record.activity && typeof record.activity === 'object' && !Array.isArray(record.activity)
      ? record.activity as Record<string, unknown>
      : null
    const label = text(value?.label)
    if (!label) return null
    const status = value?.status === 'running' || value?.status === 'done' || value?.status === 'failed'
      ? value.status
      : 'done'
    return activity(id, label, status, text(value?.detail) || undefined, text(value?.tool) || undefined, timestampMs)
  }
  if (kind === 'system') {
    const event = record.event
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null
    return { kind, id, timestampMs, event } as BotTranscriptEntry
  }
  return null
}

/** Serialize a group entry for the application-owned recovery table. */
export function toDurableGroupEntry(entry: BotTranscriptEntry): {
  entry_id: string
  entry_kind: BotTranscriptEntry['kind']
  author_id: string | null
  author_name: string | null
  content: string | null
  payload: BotTranscriptEntry
  occurred_at: string
} {
  return {
    entry_id: entry.id,
    entry_kind: entry.kind,
    author_id: entry.kind === 'agent-message' ? entry.author?.id ?? null : null,
    author_name: entry.kind === 'agent-message' ? entry.author?.name ?? null : null,
    content: entry.kind === 'user-message' || entry.kind === 'agent-message' ? entry.content : null,
    payload: entry,
    occurred_at: new Date(entry.timestampMs).toISOString(),
  }
}

/**
 * Work-host accepts at most 500 entries per append request. Keep the limit in
 * one place so recovery and streaming mirror paths cannot silently truncate a
 * long transcript.
 */
export const WORK_HOST_TRANSCRIPT_APPEND_LIMIT = 500

/**
 * Work-host replaces a transcript in a single atomic SQLite transaction. Keep
 * the gateway limit in the client as well so recovery can fail before sending
 * a request that would be rejected after a full transcript has been read.
 */
export const WORK_HOST_TRANSCRIPT_REPLACE_LIMIT = 10_000

export class BotTranscriptReplaceLimitError extends Error {
  readonly code = 'WORK_HOST_TRANSCRIPT_REPLACE_LIMIT_EXCEEDED'
  readonly entryCount: number
  readonly limit: number

  constructor(entryCount: number, limit = WORK_HOST_TRANSCRIPT_REPLACE_LIMIT) {
    super(`Work-host transcript replacement accepts at most ${limit} entries; received ${entryCount}`)
    this.entryCount = entryCount
    this.limit = limit
    this.name = 'BotTranscriptReplaceLimitError'
  }
}

export function chunkWorkHostEntries<T>(
  entries: readonly T[],
  limit = WORK_HOST_TRANSCRIPT_APPEND_LIMIT,
): T[][] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_WORK_HOST_APPEND_LIMIT')
  const chunks: T[][] = []
  for (let offset = 0; offset < entries.length; offset += limit) {
    chunks.push(entries.slice(offset, offset + limit))
  }
  return chunks
}

function normalizedUserContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export interface BotTranscriptReconciliation {
  /** Recovered entries that are not already present in the Work-host store. */
  missing: BotTranscriptEntry[]
  /** Existing entries that are not represented by the recovered event log. */
  retained: BotTranscriptEntry[]
  /**
   * True when missing entries sort before retained entries. Appending cannot
   * restore that order, so the Work-host projection must be rebuilt from the
   * merged transcript instead.
   */
  requiresRebuild: boolean
}

/**
 * Compare the Work-host projection with the durable Code-mode event log.
 *
 * User-message ids are generated independently in the two authorities, so a
 * user message is matched by normalized content and consumed once. This keeps
 * repeated identical prompts distinct while making replay idempotent.
 */
export function reconcileBotTranscript(
  existing: readonly BotTranscriptEntry[],
  recovered: readonly BotTranscriptEntry[],
): BotTranscriptReconciliation {
  const existingById = new Map<string, BotTranscriptEntry>()
  const userMessagesByContent = new Map<string, BotTranscriptEntry[]>()
  for (const entry of existing) {
    if (entry.kind === 'user-message') {
      const key = normalizedUserContent(entry.content)
      const queue = userMessagesByContent.get(key) ?? []
      queue.push(entry)
      userMessagesByContent.set(key, queue)
      continue
    }
    existingById.set(entry.id, entry)
  }

  const consumed = new Set<string>()
  const missing: BotTranscriptEntry[] = []
  for (const entry of recovered) {
    if (entry.kind === 'user-message') {
      const queue = userMessagesByContent.get(normalizedUserContent(entry.content))
      const match = queue?.find((candidate) => !consumed.has(candidate.id))
      if (match) {
        consumed.add(match.id)
        continue
      }
      missing.push(entry)
      continue
    }
    if (existingById.has(entry.id)) {
      consumed.add(entry.id)
      continue
    }
    missing.push(entry)
  }

  const retained = existing.filter((entry) => !consumed.has(entry.id))
  // Appending can only restore entries after the newest stored entry. A missing
  // entry at or before that boundary is an ordering gap — including a same-time
  // tie, whose relative order is ambiguous — and requires an atomic rebuild.
  const newestExisting = existing.reduce(
    (newest, entry) => Math.max(newest, entry.timestampMs),
    0,
  )
  const requiresRebuild =
    existing.length > 0
    && missing.some((entry) => entry.timestampMs <= newestExisting)
  return { missing, retained, requiresRebuild }
}

/** Merge two timeline projections without dropping local-only entries. */
export function mergeBotTranscripts(
  existing: readonly BotTranscriptEntry[],
  recovered: readonly BotTranscriptEntry[],
): BotTranscriptEntry[] {
  const reconciliation = reconcileBotTranscript(existing, recovered)
  const byId = new Map<string, BotTranscriptEntry>()
  for (const entry of recovered) byId.set(entry.id, entry)
  for (const entry of reconciliation.retained) byId.set(entry.id, entry)
  return [...byId.values()].sort((left, right) => left.timestampMs - right.timestampMs)
}

export type BotTranscriptRecoveryAction = 'none' | 'append' | 'replace'

export interface BotTranscriptRecoveryPlan {
  action: BotTranscriptRecoveryAction
  /** The transcript that should be rendered even when the mirror write fails. */
  transcript: BotTranscriptEntry[]
  /** Recovered entries that are absent from the Work-host store. */
  missing: BotTranscriptEntry[]
  /** Work-host entries that are not represented by the durable event log. */
  retained: BotTranscriptEntry[]
  /** Append requests, already split at the gateway limit. */
  appendChunks: BotTranscriptEntry[][]
  /**
   * Set only for a required rebuild that exceeds the atomic replacement limit.
   * The caller must keep `transcript` and defer the mirror rather than
   * truncating either authority.
   */
  replaceLimitError: BotTranscriptReplaceLimitError | null
}

/**
 * Decide how to repair the Work-host projection without performing I/O.
 *
 * A lost tail is append-only. A gap before the newest stored entry is an
 * ordering violation and must be replaced atomically. If that replacement
 * would exceed Work-host's transaction limit, the plan reports the limit error
 * while still returning the complete durable transcript for rendering.
 */
export function planBotTranscriptRecovery(
  existing: readonly BotTranscriptEntry[],
  recovered: readonly BotTranscriptEntry[],
): BotTranscriptRecoveryPlan {
  const reconciliation = reconcileBotTranscript(existing, recovered)
  if (!reconciliation.missing.length) {
    return {
      action: 'none',
      transcript: [...existing],
      missing: [],
      retained: reconciliation.retained,
      appendChunks: [],
      replaceLimitError: null,
    }
  }

  const transcript = mergeBotTranscripts(existing, recovered)
  if (reconciliation.requiresRebuild) {
    return {
      action: 'replace',
      transcript,
      missing: reconciliation.missing,
      retained: reconciliation.retained,
      appendChunks: [],
      replaceLimitError: transcript.length > WORK_HOST_TRANSCRIPT_REPLACE_LIMIT
        ? new BotTranscriptReplaceLimitError(transcript.length)
        : null,
    }
  }

  return {
    action: 'append',
    transcript,
    missing: reconciliation.missing,
    retained: reconciliation.retained,
    appendChunks: chunkWorkHostEntries(reconciliation.missing),
    replaceLimitError: null,
  }
}

export function previewFromEntries(entries: readonly BotTranscriptEntry[]): string {
  const last = [...entries].reverse().find((entry) => entry.kind === 'user-message' || entry.kind === 'agent-message')
  if (!last) return ''
  const content = last.content.replace(/[#*_`>\-\[\]()]/g, '').replace(/\s+/g, ' ').trim()
  return content.length > 180 ? `${content.slice(0, 180)}…` : content
}

function toolLabel(name: string): string {
  const normalized = name.toLowerCase()
  if (/bash|shell|terminal|command/.test(normalized)) return 'Running a command'
  if (/read/.test(normalized)) return 'Reading a file'
  if (/write/.test(normalized)) return 'Writing a file'
  if (/edit|patch/.test(normalized)) return 'Editing a file'
  if (/search|grep|find/.test(normalized)) return 'Searching'
  if (/browser|fetch|http|web/.test(normalized)) return 'Using the web'
  return `Using ${name || 'a tool'}`
}

function summarizeInput(input: unknown): string | undefined {
  if (typeof input === 'string') return input.slice(0, 300)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'command', 'query', 'url', 'pattern']) {
    if (typeof record[key] === 'string') return String(record[key]).slice(0, 300)
  }
  return undefined
}

function boundedOutput(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.trim().slice(0, 600)
}

export interface BotEventAccumulatorResult {
  updates: BotStreamUpdate[]
  persisted: BotTranscriptEntry[]
}

/** Maps the shared Pi/Codex event stream onto the existing Bot timeline vocabulary. */
export class BotEventAccumulator {
  private readonly assistantBuffers = new Map<string, string>()
  private readonly persistedIds = new Set<string>()
  private readonly toolLabels = new Map<string, string>()

  consume(event: OpenLinkAgentEvent): BotEventAccumulatorResult {
    const updates: BotStreamUpdate[] = []
    const persisted: BotTranscriptEntry[] = []
    const at = Date.parse(event.timestamp) || Date.now()

    const addActivity = (
      id: string,
      label: string,
      status: BotActivityStatus,
      detail?: string,
      tool?: string,
      persist = status !== 'running',
    ) => {
      const entry = activity(id, label, status, detail, tool, at)
      updates.push({ type: 'entry', entry })
      if (persist && !this.persistedIds.has(entry.id)) {
        this.persistedIds.add(entry.id)
        persisted.push(entry)
      }
    }

    switch (event.type) {
      case 'reasoning.started':
        updates.push({ type: 'pending', pending: { label: 'Thinking', showLabel: true } })
        break
      case 'reasoning.completed':
        updates.push({ type: 'pending', pending: { label: 'Working', showLabel: true } })
        break
      case 'message.delta': {
        const id = `bot-message-${safeId(event.messageId, 'assistant')}`
        this.assistantBuffers.set(id, `${this.assistantBuffers.get(id) ?? ''}${event.delta}`)
        updates.push({ type: 'pending', pending: { label: 'Working', showLabel: true } })
        updates.push({ type: 'delta', id, delta: event.delta })
        break
      }
      case 'message.completed': {
        const id = `bot-message-${safeId(event.messageId, 'assistant')}`
        const content = (event.text ?? this.assistantBuffers.get(id) ?? '').trim()
        this.assistantBuffers.delete(id)
        if (content) {
          const entry: BotTranscriptEntry = { kind: 'agent-message', id, content, timestampMs: at }
          updates.push({ type: 'entry', entry })
          if (!this.persistedIds.has(id)) {
            this.persistedIds.add(id)
            persisted.push(entry)
          }
        }
        updates.push({ type: 'pending', pending: { label: 'Working', showLabel: true } })
        break
      }
      case 'tool.started': {
        const label = toolLabel(event.name)
        this.toolLabels.set(event.toolId, label)
        addActivity(`bot-tool-${safeId(event.toolId, 'tool')}`, label, 'running', summarizeInput(event.input), event.name, false)
        updates.push({ type: 'pending', pending: { label, showLabel: true } })
        break
      }
      case 'tool.completed':
        addActivity(
          `bot-tool-${safeId(event.toolId, 'tool')}`,
          this.toolLabels.get(event.toolId) ?? 'Tool finished',
          'done',
          boundedOutput(event.output),
        )
        break
      case 'tool.failed':
        addActivity(
          `bot-tool-${safeId(event.toolId, 'tool')}`,
          this.toolLabels.get(event.toolId) ?? 'Tool failed',
          'failed',
          event.error,
        )
        break
      case 'command.started':
        this.toolLabels.set(event.commandId, 'Running a command')
        addActivity(`bot-command-${safeId(event.commandId, 'command')}`, 'Running a command', 'running', event.command.slice(0, 300), 'shell', false)
        updates.push({ type: 'pending', pending: { label: 'Running a command', showLabel: true } })
        break
      case 'command.completed':
        addActivity(
          `bot-command-${safeId(event.commandId, 'command')}`,
          'Command finished',
          event.exitCode === undefined || event.exitCode === 0 ? 'done' : 'failed',
          boundedOutput(event.output),
          'shell',
        )
        break
      case 'file.editing.started':
      case 'file.editing.updated':
        addActivity(
          `bot-file-${safeId(event.editId, 'edit')}`,
          `${event.operation === 'write' ? 'Writing' : 'Editing'} ${event.path}`,
          'running',
          undefined,
          'file',
          false,
        )
        break
      case 'file.editing.completed':
        addActivity(`bot-file-${safeId(event.editId, 'edit')}`, `${event.operation === 'write' ? 'Wrote' : 'Edited'} ${event.path}`, 'done', undefined, 'file')
        break
      case 'file.editing.failed':
        addActivity(`bot-file-${safeId(event.editId, 'edit')}`, `Could not edit ${event.path}`, 'failed', event.error, 'file')
        break
      case 'file.changed': {
        const files = Array.isArray(event.files)
          ? event.files.flatMap((file) => typeof file === 'string' ? [file] : file?.path ? [file.path] : [])
          : []
        addActivity(
          `bot-change-${safeId(event.changeId, 'change')}`,
          event.label || 'Updated files',
          'done',
          files.length ? files.slice(0, 8).join(', ') : undefined,
          'file',
        )
        break
      }
      case 'checkpoint.created': {
        const metrics = event.metrics
        const detail = metrics
          ? [
              metrics.actions === undefined ? '' : `${metrics.actions} actions`,
              metrics.credits === undefined ? '' : `${metrics.credits} credits`,
              metrics.model ? metrics.model : '',
            ].filter(Boolean).join(' · ')
          : undefined
        addActivity(`bot-checkpoint-${safeId(event.checkpointId, 'checkpoint')}`, event.label || 'Checkpoint created', 'done', detail || undefined, 'checkpoint')
        break
      }
      case 'confirmation.requested': {
        const label = event.confirmationKind === 'question' ? 'Waiting for your answer' : 'Approval needed'
        const request = botConfirmationRequest(event)
        addActivity(
          `bot-confirmation-${safeId(event.confirmationId, 'confirmation')}`,
          label,
          'running',
          [event.title, event.message].filter(Boolean).join(' — ').slice(0, 2000) || undefined,
          'confirmation',
          true,
        )
        if (request) updates.push({ type: 'confirmation', request })
        updates.push({ type: 'pending', pending: { label, showLabel: true } })
        break
      }
      case 'confirmation.resolved':
        addActivity(
          `bot-confirmation-${safeId(event.confirmationId, 'confirmation')}`,
          event.approved ? 'Approved' : 'Declined',
          'done',
          event.value,
          'confirmation',
        )
        updates.push({ type: 'confirmation-resolved', id: event.confirmationId })
        updates.push({ type: 'pending', pending: { label: 'Working', showLabel: true } })
        break
      case 'task.updated':
        addActivity(
          `bot-task-${safeId(event.taskId, 'task')}`,
          event.label,
          event.status === 'failed' ? 'failed' : event.status === 'completed' ? 'done' : 'running',
          event.detail,
          'task',
          event.status !== 'active',
        )
        if (event.status === 'active') updates.push({ type: 'pending', pending: { label: event.label, showLabel: true } })
        break
      case 'status.updated':
        addActivity(
          `bot-status-${safeId(event.statusId, 'status')}`,
          event.label,
          event.status === 'failed' ? 'failed' : event.status === 'completed' ? 'done' : 'running',
          event.detail,
          'status',
          event.status !== 'active',
        )
        break
      case 'error':
        addActivity(`bot-error-${safeId(event.errorId, 'error')}`, event.recoverable ? 'Recoverable error' : 'Run failed', 'failed', event.message, 'error')
        updates.push({ type: 'pending', pending: null })
        break
      case 'session.completed':
        updates.push({ type: 'pending', pending: null })
        break
      default:
        break
    }
    return { updates, persisted }
  }

  /** Persist assistant text when the stream ends without message.completed. */
  flush(): BotTranscriptEntry[] {
    const entries: BotTranscriptEntry[] = []
    for (const [id, raw] of this.assistantBuffers) {
      const content = raw.trim()
      if (!content || this.persistedIds.has(id)) continue
      this.persistedIds.add(id)
      entries.push({ kind: 'agent-message', id, content, timestampMs: Date.now() })
    }
    this.assistantBuffers.clear()
    return entries
  }
}

/** Rebuild a bot transcript from the durable Code-mode event log after a Work-host state loss. */
export function transcriptFromAgentEvents(events: readonly OpenLinkAgentEvent[]): BotTranscriptEntry[] {
  const accumulator = new BotEventAccumulator()
  const entries = new Map<string, BotTranscriptEntry>()
  for (const event of events) {
    if (event.type === 'message.user') {
      entries.set(`bot-user-${safeId(event.messageId, event.id)}`, {
        kind: 'user-message',
        id: `bot-user-${safeId(event.messageId, event.id)}`,
        content: event.text,
        timestampMs: Date.parse(event.timestamp) || Date.now(),
      })
      continue
    }
    const result = accumulator.consume(event)
    for (const entry of result.persisted) entries.set(entry.id, entry)
  }
  for (const entry of accumulator.flush()) entries.set(entry.id, entry)
  return [...entries.values()].sort((left, right) => left.timestampMs - right.timestampMs)
}
