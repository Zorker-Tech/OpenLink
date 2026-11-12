import { getBot, runBotRoutineNow } from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 300

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
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return errorResponse('BOT_NOT_FOUND', 404)
  try {
    await runBotRoutineNow(supabase, user.id, bot, routineId)
    return Response.json({ accepted: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[openlink-bots] routine run failed', error)
    return errorResponse('BOT_ROUTINE_RUN_FAILED', 502, true)
  }
}
