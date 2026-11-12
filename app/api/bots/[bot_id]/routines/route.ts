import { BotInputError, createBotRoutine, getBot, listBotRoutines } from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const SAFE_SCHEDULE = /^[A-Za-z0-9*\/,?\- ]{1,160}$/

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function routineSpec(value: unknown): { name: string; prompt: string; trigger: { type: 'cron'; schedule: string }; isEnabled?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotInputError('ROUTINE_INVALID')
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : ''
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim().slice(0, 100_000) : ''
  const schedule = typeof record.schedule === 'string' ? record.schedule.trim() : ''
  const isEnabled = record.isEnabled
  if (!name || !prompt || !SAFE_SCHEDULE.test(schedule)) throw new BotInputError('ROUTINE_INVALID')
  if (isEnabled !== undefined && typeof isEnabled !== 'boolean') throw new BotInputError('ROUTINE_INVALID')
  return {
    name,
    prompt,
    trigger: { type: 'cron', schedule },
    ...(isEnabled === undefined ? {} : { isEnabled }),
  }
}

async function ownedBot(botId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: errorResponse('AUTH_REQUIRED', 401) } as const
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return { error: errorResponse('BOT_NOT_FOUND', 404) } as const
  return { supabase, userId: user.id, bot } as const
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const owned = await ownedBot(botId)
  if ('error' in owned) return owned.error
  try {
    return Response.json({ routines: await listBotRoutines(owned.supabase, owned.userId, owned.bot) }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[openlink-bots] routines read failed', error)
    return errorResponse('BOT_ROUTINES_UNAVAILABLE', 503, true)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const owned = await ownedBot(botId)
  if ('error' in owned) return owned.error
  try {
    const spec = routineSpec(await request.json())
    const routines = await createBotRoutine(owned.supabase, owned.userId, owned.bot, spec)
    return Response.json({ routines }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof BotInputError) return errorResponse(error.message, 400)
    console.error('[openlink-bots] routine create failed', error)
    return errorResponse('BOT_ROUTINE_WRITE_FAILED', 502, true)
  }
}
