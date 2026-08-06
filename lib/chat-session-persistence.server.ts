import 'server-only'

import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { isOpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>
type UnknownRecord = Record<string, unknown>

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
  const entries = value.entries.map((candidate) => {
    const entry = asRecord(candidate)
    if (!entry || typeof entry.id !== 'string' || typeof entry.type !== 'string' || typeof entry.timestamp !== 'string') {
      throw new Error('INVALID_PI_SESSION_ENTRY')
    }
    if (entry.parentId !== null && typeof entry.parentId !== 'string') throw new Error('INVALID_PI_SESSION_ENTRY')
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
    .from('chat_session_events')
    .select('sequence')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? Number((data as { sequence: number }).sequence) + 1 : 0
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
    .insert(events.map((event) => ({
      session_id: sessionId,
      user_id: userId,
      sequence: event.sequence,
      event_id: event.id,
      event_type: event.type,
      occurred_at: event.timestamp,
      payload: event,
    })))
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

  const { error: entriesError } = await supabase
    .schema('openlink')
    .from('chat_session_pi_entries')
    .upsert(delta.entries.map((entry) => ({
      session_id: sessionId,
      user_id: userId,
      entry_id: entry.id as string,
      parent_id: typeof entry.parentId === 'string' ? entry.parentId : null,
      entry_type: entry.type as string,
      entry_timestamp: entry.timestamp as string,
      entry,
    })), { onConflict: 'session_id,entry_id', ignoreDuplicates: true })
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
  const [{ data: session, error: sessionError }, { data: entries, error: entriesError }] = await Promise.all([
    supabase
      .schema('openlink')
      .from('chat_session_pi_sessions')
      .select('header')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .schema('openlink')
      .from('chat_session_pi_entries')
      .select('entry')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('entry_timestamp', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(50_000),
  ])
  if (sessionError) throw sessionError
  if (entriesError) throw entriesError
  if (!session) return null
  const header = asRecord((session as { header: unknown }).header)
  if (!header) throw new Error('INVALID_PI_SESSION_HEADER')
  return {
    header,
    entries: (entries ?? []).map((row) => asRecord((row as { entry: unknown }).entry)).filter((entry): entry is UnknownRecord => Boolean(entry)),
  }
}
