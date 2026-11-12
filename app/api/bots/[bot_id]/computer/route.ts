import { ensureBotRuntimeProjection, getBot, updateBotRuntimeState } from '@/lib/bots'
import { BotRuntimeError, warmBotRuntime } from '@/lib/bot-runtime.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 900

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
    // Always ensure before handing out a desktop: this resumes a paused
    // sandbox and refreshes a binding that a restart made stale.
    const warmed = await warmBotRuntime(supabase, user.id, bot)
    // A successful desktop ensure is also proof the Bot runtime is ready; keep
    // the projection aligned so the composer does not stay disabled.
    await updateBotRuntimeState(supabase, user.id, bot.id, { status: 'ready' }).catch((stateError) => {
      console.error('[openlink-bots] Bot runtime state could not be recorded after computer ensure', stateError)
    })
    return Response.json({ desktopUrl: warmed.desktopUrl }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof BotRuntimeError) return errorResponse(error.code, error.status, error.retryable)
    console.error('[openlink-bots] Bot computer resolution failed', error)
    return errorResponse('BOT_RUNTIME_UNAVAILABLE', 503, true)
  }
}
