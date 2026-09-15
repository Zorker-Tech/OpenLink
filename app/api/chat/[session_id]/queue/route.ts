import { randomBytes } from 'node:crypto'
import { parsePromptAttachments } from '@/lib/agent-runtime/prompt-attachments'
import type { ClaimedChatPrompt, PromptModelSelection, QueuedChatPrompt } from '@/lib/chat-prompt-queue'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { resolvePromptFileAttachments } from '@/lib/chat-session-uploads.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

interface QueueRow {
  id: string
  message: string
  attachments: unknown
  provider_id: string | null
  model_id: string | null
  claim_token: string | null
  claim_expires_at: string | null
  created_at: string
}

function queuedPrompt(row: QueueRow, now = Date.now()): QueuedChatPrompt {
  return {
    id: row.id,
    text: row.message,
    attachments: parsePromptAttachments(row.attachments) ?? [],
    model: row.provider_id && row.model_id ? { providerId: row.provider_id, modelId: row.model_id } : null,
    claimed: Boolean(row.claim_token && row.claim_expires_at && Date.parse(row.claim_expires_at) > now),
    createdAt: row.created_at,
  }
}

async function authenticatedSession(sessionId: string) {
  if (!isChatSessionId(sessionId)) return { response: Response.json({ error: 'INVALID_SESSION' }, { status: 404 }) } as const
  const db = await createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return { response: Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 }) } as const
  const session = await getChatSession(db, user.id, sessionId)
  if (!session) return { response: Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 }) } as const
  return { db, user, session } as const
}

export async function GET(_request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const auth = await authenticatedSession(sessionId)
  if ('response' in auth) return auth.response
  const { data, error } = await auth.db.schema('openlink').from('chat_session_prompt_queue')
    .select('id,message,attachments,provider_id,model_id,claim_token,claim_expires_at,created_at')
    .eq('session_id', sessionId)
    .eq('user_id', auth.user.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) return Response.json({ error: 'QUEUE_READ_FAILED' }, { status: 500 })
  return Response.json({ items: (data as QueueRow[]).map((row) => queuedPrompt(row)) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const auth = await authenticatedSession(sessionId)
  if ('response' in auth) return auth.response
  let body: { id?: unknown; message?: unknown; attachments?: unknown; model?: unknown }
  try { body = await request.json() as typeof body } catch { return Response.json({ error: 'INVALID_BODY' }, { status: 400 }) }
  const id = typeof body.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id) ? body.id : null
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 10_000) : ''
  const attachments = parsePromptAttachments(body.attachments)
  if (!id) return Response.json({ error: 'INVALID_QUEUE_ID' }, { status: 400 })
  if (!attachments) return Response.json({ error: 'INVALID_ATTACHMENTS' }, { status: 400 })
  if (!message && !attachments.length) return Response.json({ error: 'MESSAGE_REQUIRED' }, { status: 400 })
  try {
    // Queue rows only retain lightweight metadata, but every upload handle must
    // already exist and belong to this session before it can be enqueued.
    await resolvePromptFileAttachments(auth.db, sessionId, auth.user.id, attachments)
  } catch {
    return Response.json({ error: 'UPLOAD_NOT_FOUND' }, { status: 400 })
  }
  let model: PromptModelSelection | null = null
  if (body.model !== undefined && body.model !== null) {
    if (!body.model || typeof body.model !== 'object') return Response.json({ error: 'INVALID_MODEL' }, { status: 400 })
    const candidate = body.model as Record<string, unknown>
    if (typeof candidate.providerId !== 'string' || !candidate.providerId || candidate.providerId.length > 120
      || typeof candidate.modelId !== 'string' || !candidate.modelId || candidate.modelId.length > 240) {
      return Response.json({ error: 'INVALID_MODEL' }, { status: 400 })
    }
    model = { providerId: candidate.providerId, modelId: candidate.modelId }
  }
  const { data, error } = await auth.db.schema('openlink').rpc('enqueue_chat_prompt', {
    p_id: id,
    p_session_id: sessionId,
    p_user_id: auth.user.id,
    p_message: message,
    p_attachments: attachments,
    p_provider_id: model?.providerId ?? null,
    p_model_id: model?.modelId ?? null,
  })
  if (error) return Response.json({ error: error.message === 'chat prompt queue is full' ? 'QUEUE_FULL' : 'QUEUE_WRITE_FAILED' }, { status: error.message === 'chat prompt queue is full' ? 409 : 500 })
  const row = (data as QueueRow[] | null)?.[0]
  if (!row) return Response.json({ error: 'QUEUE_WRITE_FAILED' }, { status: 500 })
  return Response.json({ item: queuedPrompt(row) }, { status: 201 })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const auth = await authenticatedSession(sessionId)
  if ('response' in auth) return auth.response
  let body: { action?: unknown; id?: unknown; claimToken?: unknown }
  try { body = await request.json() as typeof body } catch { return Response.json({ error: 'INVALID_BODY' }, { status: 400 }) }
  if (body.action === 'claim') {
    const claimToken = randomBytes(24).toString('base64url')
    const { data, error } = await auth.db.schema('openlink').rpc('claim_next_chat_prompt', {
      p_session_id: sessionId,
      p_user_id: auth.user.id,
      p_claim_token: claimToken,
      p_ttl_seconds: 120,
    })
    if (error) return Response.json({ error: 'QUEUE_CLAIM_FAILED' }, { status: 500 })
    const row = (data as QueueRow[] | null)?.[0]
    if (!row) return new Response(null, { status: 204 })
    const item: ClaimedChatPrompt = { ...queuedPrompt(row), claimed: true, claimToken }
    return Response.json({ item })
  }
  const id = typeof body.id === 'string' ? body.id : ''
  const claimToken = typeof body.claimToken === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(body.claimToken) ? body.claimToken : ''
  if (!id || !claimToken || (body.action !== 'complete' && body.action !== 'release')) {
    return Response.json({ error: 'INVALID_QUEUE_ACTION' }, { status: 400 })
  }
  const result = await auth.db.schema('openlink').rpc('finish_chat_prompt_claim', {
    p_id: id,
    p_session_id: sessionId,
    p_user_id: auth.user.id,
    p_claim_token: claimToken,
    p_complete: body.action === 'complete',
  })
  if (result.error) return Response.json({ error: body.action === 'complete' ? 'QUEUE_COMPLETE_FAILED' : 'QUEUE_RELEASE_FAILED' }, { status: 500 })
  if (!result.data) return Response.json({ error: 'QUEUE_CLAIM_LOST' }, { status: 409 })
  return Response.json({ ok: true })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  const auth = await authenticatedSession(sessionId)
  if ('response' in auth) return auth.response
  const id = new URL(request.url).searchParams.get('id')
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: 'INVALID_QUEUE_ID' }, { status: 400 })
  }
  const { error } = await auth.db.schema('openlink').rpc('delete_queued_chat_prompts', {
    p_session_id: sessionId,
    p_user_id: auth.user.id,
    p_id: id,
  })
  if (error) return Response.json({ error: 'QUEUE_DELETE_FAILED' }, { status: 500 })
  return Response.json({ ok: true })
}
