import 'server-only'

import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { isOpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>
type UnknownRecord = Record<string, unknown>

// Reserve a range once per HTTP stream. The adapter can then assign
// monotonically increasing event sequences without a read-max/write race when
// two browser tabs retry or submit at the same time. Gaps are intentional and
// are harmless because reads order by sequence and event ids remain unique.
// A stream gets a private block so event persistence never performs a database
// round-trip per token. Keep the block large enough for a long tool-heavy turn;
// the database function caps reservations at one million.
const EVENT_SEQUENCE_RESERVATION_SIZE = 1_000_000

const asRecord = (value: unknown): UnknownRecord | null => value && typeof value === 'object' ? value as UnknownRecord : null

export interface PiSessionDelta {
  header: UnknownRecord
  entries: UnknownRecord[]
}

export function parsePiSessionDelta(frame: unknown): PiSessionDelta | null {
  const value = asRecord(frame)
  if (value?.type !== 'openlink_session_entries') return null
  const header = asRecord(value.header)
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || typeof header.timestamp !== 'string') {
    throw new Error('INVALID_PI_SESSION_HEADER')
  }
  if (!Array.isArray(value.entries) || value.entries.length > 10_000) throw new Error('INVALID_PI_SESSION_ENTRIES')
  const entryIds = new Set<string>()
  const entries = value.entries.map((candidate) => {
    const entry = asRecord(candidate)
    if (!entry || typeof entry.id !== 'string' || typeof entry.type !== 'string' || typeof entry.timestamp !== 'string') {
      throw new Error('INVALID_PI_SESSION_ENTRY')
    }
    if (entry.parentId !== null && typeof entry.parentId !== 'string') throw new Error('INVALID_PI_SESSION_ENTRY')
    if (entryIds.has(entry.id as string)) throw new Error('INVALID_PI_SESSION_ENTRY')
    entryIds.add(entry.id as string)
    return entry
  })
  return { header, entries }
}

export async function nextChatEventSequence(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .rpc('reserve_chat_event_sequences', {
      p_session_id: sessionId,
      p_user_id: userId,
      p_count: EVENT_SEQUENCE_RESERVATION_SIZE,
    })
  if (error) throw error
  const sequence = Number(data)
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('INVALID_CHAT_EVENT_SEQUENCE')
  return sequence
}

export async function persistChatEvents(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
  events: OpenLinkAgentEvent[],
) {
  if (!events.length) return
  const { error } = await supabase
    .schema('openlink')
    .from('chat_session_events')
    .upsert(events.map((event) => ({
      session_id: sessionId,
      user_id: userId,
      sequence: event.sequence,
      event_id: event.id,
      event_type: event.type,
      occurred_at: event.timestamp,
      payload: event,
    })), { onConflict: 'session_id,event_id', ignoreDuplicates: true })
  if (error) throw error
}

export async function persistPiSessionDelta(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
  delta: PiSessionDelta,
) {
  const header = delta.header
  const { error: headerError } = await supabase
    .schema('openlink')
    .from('chat_session_pi_sessions')
    .upsert({
      session_id: sessionId,
      user_id: userId,
      pi_session_id: header.id as string,
      version: typeof header.version === 'number' ? header.version : null,
      header,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'session_id' })
  if (headerError) throw headerError
  if (!delta.entries.length) return

  // Pi's parent-linked session is an ordered JSONL log. Appending by reading
  // MAX(entry_order) in the application is racy across Agent Host instances
  // (a lease can expire or a second deployment can be serving the same user).
  // The database function locks the session row and assigns ordinals while it
  // de-duplicates entry ids, so a retry cannot fork or truncate the native log.
  const { error: entriesError } = await supabase
    .schema('openlink')
    .rpc('append_chat_session_pi_entries', {
      p_session_id: sessionId,
      p_user_id: userId,
      p_entries: delta.entries,
    })
  if (entriesError) throw entriesError
}

export async function listPersistedChatEvents(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
): Promise<OpenLinkAgentEvent[]> {
  // PostgREST applies the project max-rows setting to every response (often
  // 1,000), even when a larger limit is requested. Page explicitly so a
  // reopened session restores its complete event history and derives the
  // correct final Working/Worked state.
  const pageSize = 1_000
  const events: OpenLinkAgentEvent[] = []
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .schema('openlink')
      .from('chat_session_events')
      .select('payload')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('sequence', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) throw error

    const page = (data ?? [])
      .map((row) => (row as { payload: unknown }).payload)
      .filter(isOpenLinkAgentEvent)
    events.push(...page)
    if ((data ?? []).length < pageSize) break
  }
  return events
}

export async function loadPiSessionSnapshot(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
): Promise<PiSessionDelta | null> {
  const { data: session, error: sessionError } = await supabase
    .schema('openlink')
    .from('chat_session_pi_sessions')
    .select('header')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (sessionError) throw sessionError
  if (!session) return null

  // PostgREST caps responses (commonly at 1,000 rows), so a single limit(50k)
  // silently truncated long Pi sessions. Page until the final short response.
  const pageSize = 1_000
  const entries: Array<{ entry: unknown }> = []
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .schema('openlink')
      .from('chat_session_pi_entries')
      .select('entry')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('entry_order', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    entries.push(...((data ?? []) as Array<{ entry: unknown }>))
    if ((data ?? []).length < pageSize) break
  }

  const header = asRecord((session as { header: unknown }).header)
  if (!header) throw new Error('INVALID_PI_SESSION_HEADER')
  return {
    header,
    entries: entries.map((row) => asRecord(row.entry)).filter((entry): entry is UnknownRecord => Boolean(entry)),
  }
}
