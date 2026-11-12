import { appendBotConfirmationResolved, ensureBotRuntimeProjection, getBot } from '@/lib/bots'
import { BotRuntimeError, respondBotConfirmation } from '@/lib/bot-runtime.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

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

/**
 * Answer a Pi dialog waiting inside the Bot's worker. The answer goes through
 * Work-host's Bot runtime command; it is not a new prompt and it does not
 * address a Code session.
 */
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
  if (!bot.runtimeKey) return errorResponse('BOT_RUNTIME_NOT_READY', 409, true)

  let body: { id: string; approved?: boolean; value?: string }
  try {
    body = parseBody(await request.json())
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }

  try {
    await respondBotConfirmation(bot, body)
  } catch (error) {
    if (error instanceof BotRuntimeError) return errorResponse(error.code, error.status, error.retryable)
    console.error('[openlink-bots] Bot confirmation response failed', error)
    return errorResponse('BOT_CONFIRMATION_FAILED', 502, true)
  }

  // The worker has accepted the answer. Record the resolution so a reopened
  // Bot does not show the same question; a failed marker is not a reason to
  // report the answer as failed.
  await appendBotConfirmationResolved(supabase, user.id, bot, body.id).catch((error) => {
    console.error('[openlink-bots] Bot confirmation resolution could not be recorded', error)
  })
  return Response.json({ ok: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
}
