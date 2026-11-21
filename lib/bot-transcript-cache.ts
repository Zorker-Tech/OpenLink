import { OPTIMISTIC_USER_ENTRY_PREFIX, type BotTranscriptEntry } from './bot-transcript.ts'
import type { BotDetail, BotSummary } from './bot-types.ts'

const CACHE_VERSION = 1
const MAX_CACHE_AGE_MS = 24 * 60 * 60_000
const MAX_CACHED_BOTS = 12
const MAX_CACHED_ENTRIES = 80
const MAX_ROOM_CHARACTERS = 48_000

type CachedTimeline = {
  botId: string
  workAgentId: string
  entries: BotTranscriptEntry[]
}

function storedTimeline(detail: BotDetail): CachedTimeline {
  const entries: BotTranscriptEntry[] = []
  let length = 0
  for (let index = detail.transcript.length - 1; index >= 0 && entries.length < MAX_CACHED_ENTRIES; index -= 1) {
    const entry = detail.transcript[index]!
    if (entry.id.startsWith(OPTIMISTIC_USER_ENTRY_PREFIX) || entry.kind === 'confirmation') continue
    if (entry.kind === 'activity' && entry.activity.status === 'running') continue
    length += JSON.stringify(entry).length
    if (length > MAX_ROOM_CHARACTERS) break
    entries.push(entry)
  }
  return { botId: detail.id, workAgentId: detail.workAgentId, entries: entries.reverse() }
}

export function encodeBotTimelineCache(details: readonly BotDetail[]): string {
  return JSON.stringify({
    version: CACHE_VERSION,
    savedAt: Date.now(),
    rooms: details.slice(0, MAX_CACHED_BOTS).map(storedTimeline),
  })
}

export function botDetailFromTimeline(bot: BotSummary, transcript: BotTranscriptEntry[]): BotDetail {
  return {
    ...bot,
    transcript,
    runtimeReady: bot.runtimeStatus === 'ready' && (bot.kind !== 'group' || bot.members.length > 0),
    pendingConfirmations: [],
    routines: [],
  }
}

export function decodeBotTimelineCache(raw: string, bots: readonly BotSummary[]): Record<string, BotDetail> {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; savedAt?: unknown; rooms?: unknown } | null
    if (parsed?.version !== CACHE_VERSION || typeof parsed.savedAt !== 'number' ||
        Date.now() - parsed.savedAt > MAX_CACHE_AGE_MS || !Array.isArray(parsed.rooms)) return {}
    const botsById = new Map(bots.map(bot => [bot.id, bot]))
    const result: Record<string, BotDetail> = {}
    for (const room of parsed.rooms.slice(0, MAX_CACHED_BOTS)) {
      if (!room || typeof room.botId !== 'string' || !Array.isArray(room.entries)) continue
      const bot = botsById.get(room.botId)
      if (!bot || room.workAgentId !== bot.workAgentId) continue
      if (room.entries.length === 0 && bot.lastEntryText) continue
      const entries = room.entries.slice(-MAX_CACHED_ENTRIES).filter((value: unknown): value is BotTranscriptEntry => {
        if (!value || typeof value !== 'object') return false
        const entry = value as BotTranscriptEntry
        if (typeof entry.id !== 'string' || (entry.timestampMs !== undefined && !Number.isFinite(entry.timestampMs))) return false
        if (entry.kind === 'user-message' || entry.kind === 'agent-message') return typeof entry.content === 'string'
        return entry.kind === 'system' ? Boolean(entry.event) : entry.kind === 'activity' && Boolean(entry.activity)
      })
      result[bot.id] = botDetailFromTimeline(bot, entries)
    }
    return result
  } catch {
    return {}
  }
}

export function mergeBotTimelineSnapshot(
  stored: BotTranscriptEntry[],
  before: readonly BotTranscriptEntry[],
  current: readonly BotTranscriptEntry[],
): BotTranscriptEntry[] {
  const previous = new Map(before.map(entry => [entry.id, entry]))
  const storedIds = new Set(stored.map(entry => entry.id))
  const storedNonces = new Set(stored.map(entry => entry.clientNonce).filter(Boolean))
  const updates = new Map(current.filter(entry =>
    entry.id.startsWith(OPTIMISTIC_USER_ENTRY_PREFIX) || previous.get(entry.id) !== entry,
  ).map(entry => [entry.id, entry]))
  return [
    ...stored.map(entry => updates.get(entry.id) ?? entry),
    ...[...updates.values()].filter(entry => !storedIds.has(entry.id) && (!entry.clientNonce || !storedNonces.has(entry.clientNonce))),
  ]
}
