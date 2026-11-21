import { getBot, isBotId } from '@/lib/bots'
import {
  getBotInspiration,
  nominateBotInspiration,
  recordBotInspirationFeedback,
  runBotInspirationNow,
  setBotInspiration,
  type WorkHostInspirationConfig,
} from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 300

function errorResponse(code: string, status: number) {
  return Response.json({ error: { code, message: code } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  if (!isBotId(botId)) return errorResponse('BOT_NOT_FOUND', 404)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return errorResponse('BOT_NOT_FOUND', 404)
  try {
    const inspiration = await getBotInspiration(bot.workAgentId)
    return Response.json({
      inspiration,
      budgetUsdPerDay: bot.inspirationBudgetUsd,
      instructions: bot.instructions,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[openlink-bots] inspiration read failed', error)
    return errorResponse('INSPIRATION_READ_FAILED', 502)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  if (!isBotId(botId)) return errorResponse('BOT_NOT_FOUND', 404)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return errorResponse('BOT_NOT_FOUND', 404)
  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }
  const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
    ? body.config as Partial<WorkHostInspirationConfig>
    : body as Partial<WorkHostInspirationConfig>
  try {
    const inspiration = await setBotInspiration(bot.workAgentId, config)
    return Response.json({ inspiration }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[openlink-bots] inspiration update failed', error)
    return errorResponse('INSPIRATION_UPDATE_FAILED', 502)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  if (!isBotId(botId)) return errorResponse('BOT_NOT_FOUND', 404)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return errorResponse('BOT_NOT_FOUND', 404)
  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }
  const action = typeof body.action === 'string' ? body.action : ''
  try {
    if (action === 'run-now') {
      const result = await runBotInspirationNow(bot.workAgentId)
      return Response.json({ result }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (action === 'feedback') {
      const recordId = typeof body.recordId === 'string' ? body.recordId : ''
      const feedback = body.feedback
      if (!recordId || (feedback !== 'useful' && feedback !== 'not-useful' && feedback !== 'dismissed')) {
        return errorResponse('INVALID_BODY', 400)
      }
      const inspiration = await recordBotInspirationFeedback(bot.workAgentId, recordId, feedback)
      return Response.json({ inspiration }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (action === 'nominate') {
      const targetBotId = typeof body.targetBotId === 'string' ? body.targetBotId : ''
      const task = typeof body.task === 'string' ? body.task.trim() : ''
      if (!isBotId(targetBotId) || !task) return errorResponse('INVALID_BODY', 400)
      const target = await getBot(supabase, user.id, targetBotId)
      if (!target) return errorResponse('BOT_NOT_FOUND', 404)
      const result = await nominateBotInspiration(bot.workAgentId, target.workAgentId, task.slice(0, 2000))
      return Response.json({ result }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return errorResponse('INVALID_ACTION', 400)
  } catch (error) {
    console.error('[openlink-bots] inspiration action failed', error)
    return errorResponse('INSPIRATION_ACTION_FAILED', 502)
  }
}
