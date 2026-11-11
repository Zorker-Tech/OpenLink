import { ensureBotRuntimeProjection, getBot } from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/+$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function parseBody(value: unknown): { id: string; approved?: boolean; value?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_BODY')
  const body = value as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id : ''
  const approved = body.approved
  const text = body.value
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new Error('INVALID_BODY')
  if (approved !== undefined && typeof approved !== 'boolean') throw new Error('INVALID_BODY')
  if (text !== undefined && (typeof text !== 'string' || text.length > 100_000)) throw new Error('INVALID_BODY')
  if (approved === undefined && text === undefined) throw new Error('INVALID_BODY')
  if (approved !== undefined && text !== undefined) throw new Error('INVALID_BODY')
  return { id, ...(approved === undefined ? {} : { approved }), ...(text === undefined ? {} : { value: text }) }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const found = await getBot(supabase, user.id, botId)
  if (!found) return errorResponse('BOT_NOT_FOUND', 404)
  let bot: NonNullable<Awaited<ReturnType<typeof getBot>>>
  try {
    bot = await ensureBotRuntimeProjection(supabase, user.id, found)
  } catch (error) {
    console.error('[openlink-bots] runtime projection recovery failed', error)
    return errorResponse('BOT_PROJECTION_RECOVERY_FAILED', 503, true)
  }
  if (!bot.runtimeSessionId) return errorResponse('BOT_RUNTIME_NOT_READY', 409, true)
  const host = agentHostConfig()
  if (!host) return errorResponse('AGENT_HOST_NOT_CONFIGURED', 503, true)

  let body: { id: string; approved?: boolean; value?: string }
  try {
    body = parseBody(await request.json())
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }

  const workerResponse = body.approved === true
    ? { confirmed: true }
    : body.approved === false
      ? { cancelled: true }
      : { value: body.value! }
  let upstream: Response
  try {
    upstream = await fetch(`${host.baseUrl}/v1/agent/sessions/${encodeURIComponent(bot.runtimeSessionId)}/extension-ui-response`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: user.id,
        workspaceId: bot.workspaceId,
        projectId: bot.projectId,
        sessionId: bot.runtimeSessionId,
        id: body.id,
        ...workerResponse,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return errorResponse('AGENT_HOST_UNAVAILABLE', 502, true)
  }
  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => null) as { error?: { code?: unknown; retryable?: unknown } } | null
    const code = typeof payload?.error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(payload.error.code)
      ? payload.error.code
      : 'EXTENSION_UI_RESPONSE_FAILED'
    return errorResponse(code, upstream.status || 502, payload?.error?.retryable === true)
  }
  return Response.json({ ok: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
}
