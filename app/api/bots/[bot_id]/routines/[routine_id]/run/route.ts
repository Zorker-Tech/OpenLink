import { ensureBotRuntimeProjection, getBot, runBotRoutineNow } from '@/lib/bots'
import { BotRuntimeError, warmBotRuntime } from '@/lib/bot-runtime.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 1_800

const SAFE_ROUTINE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string; routine_id: string }> },
) {
  const { bot_id: botId, routine_id: routineId } = await params
  if (!SAFE_ROUTINE_ID.test(routineId)) return errorResponse('ROUTINE_INVALID', 400)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const found = await getBot(supabase, user.id, botId)
  if (!found) return errorResponse('BOT_NOT_FOUND', 404)

  let bot: NonNullable<Awaited<ReturnType<typeof getBot>>>
  try {
    bot = await ensureBotRuntimeProjection(supabase, user.id, found)
  } catch (error) {
    console.error('[openlink-bots] routine projection recovery failed', error)
    return errorResponse('BOT_PROJECTION_RECOVERY_FAILED', 503, true)
  }
  if (bot.kind === 'group') return errorResponse('BOT_ROUTINE_NOT_SUPPORTED', 409)
  if (!bot.runtimeKey) return errorResponse('BOT_RUNTIME_NOT_READY', 409, true)

  // A routine is a Bot turn like any other: do not dispatch it into a stale or
  // missing worker. The ensure is idempotent and refreshes the binding.
  try {
    await warmBotRuntime(supabase, user.id, bot)
  } catch (error) {
    if (error instanceof BotRuntimeError) return errorResponse(error.code, error.status, error.retryable)
    console.error('[openlink-bots] routine runtime ensure failed', error)
    return errorResponse('BOT_RUNTIME_UNAVAILABLE', 503, true)
  }

  try {
    await runBotRoutineNow(supabase, user.id, bot, routineId)
    return Response.json({ accepted: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[openlink-bots] routine run failed', error)
    return errorResponse('BOT_ROUTINE_RUN_FAILED', 502, true)
  }
}
