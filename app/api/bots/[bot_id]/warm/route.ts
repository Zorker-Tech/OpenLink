import { ensureBotRuntimeProjection, getBot, updateBotRuntimeState } from '@/lib/bots'
import { BotRuntimeError, warmBotRuntime } from '@/lib/bot-runtime.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 1_800

function errorResponse(code: string, status: number, retryable: boolean) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

/**
 * Idempotently materialise the Bot's one OpenSandbox inside the Project VM and
 * its desktop. Work-host owns the binding and the Pi worker; this route never
 * leases a Code session. Onboarding calls it after the durable Bot row is
 * created; the workspace also calls it when a Bot is selected.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401, false)
  const found = await getBot(supabase, user.id, botId)
  if (!found) return errorResponse('BOT_NOT_FOUND', 404, false)

  try {
    const bot = await ensureBotRuntimeProjection(supabase, user.id, found)
    await updateBotRuntimeState(supabase, user.id, bot.id, { status: 'provisioning' })
    const result = await warmBotRuntime(supabase, user.id, bot)
    await updateBotRuntimeState(supabase, user.id, bot.id, { status: 'ready' })
    return Response.json({
      ready: result.ready,
      agent: result.agent,
      runtimeKey: bot.runtimeKey,
      desktopUrl: result.desktopUrl,
      runtimeStatus: 'ready' as const,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof BotRuntimeError) {
      await updateBotRuntimeState(supabase, user.id, found.id, {
        status: 'failed',
        error: error.code,
      }).catch((stateError) => {
        console.error('[openlink-bots] runtime failure state could not be recorded', stateError)
      })
      return errorResponse(error.code, error.status, error.retryable)
    }
    console.error('[openlink-bots] runtime warmup failed', error)
    await updateBotRuntimeState(supabase, user.id, found.id, {
      status: 'failed',
      error: 'BOT_RUNTIME_UNAVAILABLE',
    }).catch((stateError) => {
      console.error('[openlink-bots] runtime failure state could not be recorded', stateError)
    })
    return errorResponse('BOT_RUNTIME_UNAVAILABLE', 503, true)
  }
}
