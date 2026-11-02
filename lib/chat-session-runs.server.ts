import type { SupabaseClient } from '@supabase/supabase-js'

export type ChatSessionRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface ChatSessionRun {
  id: string
  sessionId: string
  userId: string
  processId: string
  status: ChatSessionRunStatus
  startedAt: string
  heartbeatAt: string
  finishedAt: string | null
  errorCode: string | null
}

const RUN_SELECT = 'run_id, session_id, user_id, process_id, status, started_at, heartbeat_at, finished_at, error_code'

function normalizeRun(row: Record<string, unknown>): ChatSessionRun {
  return {
    id: String(row.run_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    processId: String(row.process_id),
    status: row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled' ? row.status : 'running',
    startedAt: String(row.started_at),
    heartbeatAt: String(row.heartbeat_at),
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
    errorCode: typeof row.error_code === 'string' ? row.error_code : null,
  }
}

export async function startChatSessionRun(
  supabase: SupabaseClient,
  input: { runId: string; sessionId: string; userId: string; processId: string },
): Promise<ChatSessionRun> {
  const now = new Date().toISOString()
  // A new turn may start only after the lease was acquired. Any older row
  // still marked running belongs to a crashed process; close it explicitly so
  // the UI cannot show two live processes for one session.
  const { error: supersedeError } = await supabase
    .schema('openlink')
    .from('chat_session_runs')
    .update({ status: 'failed', error_code: 'SUPERSEDED', finished_at: now, heartbeat_at: now })
    .eq('session_id', input.sessionId)
    .eq('user_id', input.userId)
    .eq('status', 'running')
  if (supersedeError) throw supersedeError

  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_session_runs')
    .insert({
      run_id: input.runId,
      session_id: input.sessionId,
      user_id: input.userId,
      process_id: input.processId,
      status: 'running',
      started_at: now,
      heartbeat_at: now,
    })
    .select(RUN_SELECT)
    .single()
  if (error) throw error
  return normalizeRun(data as Record<string, unknown>)
}

export async function heartbeatChatSessionRun(
  supabase: SupabaseClient,
  input: { runId: string; userId: string },
): Promise<void> {
  const { error } = await supabase
    .schema('openlink')
    .from('chat_session_runs')
    .update({ heartbeat_at: new Date().toISOString() })
    .eq('run_id', input.runId)
    .eq('user_id', input.userId)
    .eq('status', 'running')
  if (error) throw error
}

export async function finishChatSessionRun(
  supabase: SupabaseClient,
  input: { runId: string; userId: string; status: Exclude<ChatSessionRunStatus, 'running'>; errorCode?: string },
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .schema('openlink')
    .from('chat_session_runs')
    .update({
      status: input.status,
      finished_at: now,
      heartbeat_at: now,
      error_code: input.errorCode?.slice(0, 160) ?? null,
    })
    .eq('run_id', input.runId)
    .eq('user_id', input.userId)
    .eq('status', 'running')
  if (error) throw error
}

export async function cancelRunningChatSessionRun(
  supabase: SupabaseClient,
  input: { userId: string; sessionId: string; errorCode?: string },
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .schema('openlink')
    .from('chat_session_runs')
    .update({
      status: 'cancelled',
      finished_at: now,
      heartbeat_at: now,
      error_code: input.errorCode?.slice(0, 160) ?? 'USER_CANCELLED',
    })
    .eq('session_id', input.sessionId)
    .eq('user_id', input.userId)
    .eq('status', 'running')
  if (error) throw error
}

export async function getChatSessionRun(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
): Promise<ChatSessionRun | null> {
  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_session_runs')
    .select(RUN_SELECT)
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? normalizeRun(data as Record<string, unknown>) : null
}

export async function listLatestChatSessionRuns(
  supabase: SupabaseClient,
  userId: string,
  sessionIds: string[],
): Promise<Map<string, ChatSessionRun>> {
  const result = new Map<string, ChatSessionRun>()
  const unique = [...new Set(sessionIds)].filter(Boolean)
  if (!unique.length) return result
  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_session_runs')
    .select(RUN_SELECT)
    .eq('user_id', userId)
    .in('session_id', unique)
    .order('started_at', { ascending: false })
  if (error) throw error
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const run = normalizeRun(row)
    if (!result.has(run.sessionId)) result.set(run.sessionId, run)
  }
  return result
}

/** A running row with no recent heartbeat belongs to a dead web process. */
export function effectiveChatSessionRunStatus(run: ChatSessionRun | null, staleAfterMs = 90_000): ChatSessionRunStatus | 'idle' | 'interrupted' {
  if (!run) return 'idle'
  if (run.status !== 'running') return run.status
  return Date.now() - Date.parse(run.heartbeatAt) > staleAfterMs ? 'interrupted' : 'running'
}
