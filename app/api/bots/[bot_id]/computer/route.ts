import { ensureBotRuntimeProjection, getBot } from '@/lib/bots'
import { BotRuntimeError, getBotComputer, warmBotRuntime } from '@/lib/bot-runtime.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 300

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

/**
 * The Bot's desktop, resolved through Work-host. The Bot surface never asks
 * the Code desktop endpoint for a session; Work-host owns the Bot box and
 * returns a capability URL for its own sandbox.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const found = await getBot(supabase, user.id, botId)
  if (!found) return errorResponse('BOT_NOT_FOUND', 404)
  if (found.kind === 'group') return errorResponse('BOT_GROUP_HAS_NO_COMPUTER', 409, false)

  let bot: NonNullable<Awaited<ReturnType<typeof getBot>>>
  try {
    bot = await ensureBotRuntimeProjection(supabase, user.id, found)
  } catch (error) {
    console.error('[openlink-bots] runtime projection recovery failed', error)
    return errorResponse('BOT_PROJECTION_RECOVERY_FAILED', 503, true)
  }

  try {
    const existing = await getBotComputer(bot)
    if (existing) return Response.json(existing, { headers: { 'Cache-Control': 'no-store' } })
    const warmed = await warmBotRuntime(supabase, user.id, bot)
    return Response.json({ desktopUrl: warmed.desktopUrl }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof BotRuntimeError) return errorResponse(error.code, error.status, error.retryable)
    console.error('[openlink-bots] Bot computer resolution failed', error)
    return errorResponse('BOT_RUNTIME_UNAVAILABLE', 503, true)
  }
}
