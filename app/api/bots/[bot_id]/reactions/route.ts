import { getBot } from '@/lib/bots'
import { isMissingWorkHostAgentError, reactBotMessage, WorkHostError } from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function parseBody(value: unknown): { entryId: string; emoji: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_BODY')
  const body = value as Record<string, unknown>
  const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : ''
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(entryId)) throw new Error('INVALID_BODY')
  // A reaction is a single grapheme cluster. The upper bound leaves room for
  // ZWJ sequences, keycaps and flag pairs without accepting arbitrary text.
  if (!emoji || emoji.length > 32) throw new Error('INVALID_BODY')
  return { entryId, emoji }
}

/**
 * Toggle a reaction on a Bot message. The Work-host transcript is the durable
 * source of truth; the live update reaches every open Bot surface through the
 * `transcript` event channel.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return errorResponse('BOT_NOT_FOUND', 404)

  let body: { entryId: string; emoji: string }
  try {
    body = parseBody(await request.json())
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }

  try {
    await reactBotMessage({
      agentId: bot.workAgentId,
      entryId: body.entryId,
      emoji: body.emoji,
    })
  } catch (error) {
    if (error instanceof WorkHostError) {
      if (isMissingWorkHostAgentError(error)) return errorResponse('BOT_RUNTIME_NOT_READY', 409, true)
      return errorResponse(error.status >= 500 ? 'BOT_REACTION_FAILED' : error.message, error.status, error.status >= 500)
    }
    console.error('[openlink-bots] reaction failed', error)
    return errorResponse('BOT_REACTION_FAILED', 502, true)
  }

  return Response.json({ ok: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
}
