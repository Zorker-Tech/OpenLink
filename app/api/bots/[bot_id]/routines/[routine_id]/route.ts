import {
  BotInputError,
  deleteBotRoutine,
  getBot,
  setBotRoutineEnabled,
  updateBotRoutine,
} from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const SAFE_ROUTINE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/
const SAFE_SCHEDULE = /^[A-Za-z0-9*\/,?\- ]{1,160}$/

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function ownedBot(botId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: errorResponse('AUTH_REQUIRED', 401) } as const
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return { error: errorResponse('BOT_NOT_FOUND', 404) } as const
  return { supabase, userId: user.id, bot } as const
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ bot_id: string; routine_id: string }> },
) {
  const { bot_id: botId, routine_id: routineId } = await params
  if (!SAFE_ROUTINE_ID.test(routineId)) return errorResponse('ROUTINE_INVALID', 400)
  const owned = await ownedBot(botId)
  if ('error' in owned) return owned.error
  try {
    const body = await request.json() as Record<string, unknown>
    if (typeof body.isEnabled === 'boolean' && Object.keys(body).length === 1) {
      const routines = await setBotRoutineEnabled(owned.supabase, owned.userId, owned.bot, routineId, body.isEnabled)
      return Response.json({ routines }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 100_000) : ''
    const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : ''
    const isEnabled = body.isEnabled
    if (!name || !prompt || !SAFE_SCHEDULE.test(schedule) || (isEnabled !== undefined && typeof isEnabled !== 'boolean')) {
      throw new BotInputError('ROUTINE_INVALID')
    }
    const routines = await updateBotRoutine(owned.supabase, owned.userId, owned.bot, routineId, {
      name,
      prompt,
      trigger: { type: 'cron', schedule },
      ...(isEnabled === undefined ? {} : { isEnabled }),
    })
    return Response.json({ routines }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof BotInputError) return errorResponse(error.message, 400)
    console.error('[openlink-bots] routine update failed', error)
    return errorResponse('BOT_ROUTINE_WRITE_FAILED', 502, true)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string; routine_id: string }> },
) {
  const { bot_id: botId, routine_id: routineId } = await params
  if (!SAFE_ROUTINE_ID.test(routineId)) return errorResponse('ROUTINE_INVALID', 400)
  const owned = await ownedBot(botId)
  if ('error' in owned) return owned.error
  try {
    const routines = await deleteBotRoutine(owned.supabase, owned.userId, owned.bot, routineId)
    return Response.json({ routines }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[openlink-bots] routine delete failed', error)
    return errorResponse('BOT_ROUTINE_WRITE_FAILED', 502, true)
  }
}
