import {
  BotInputError,
  deleteBot,
  getBot,
  getBotDetail,
  markBotViewed,
  updateBot,
} from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return errorResponse('BOT_NOT_FOUND', 404)
  await markBotViewed(supabase, user.id, bot.id).catch(() => undefined)
  try {
    const detail = await getBotDetail(supabase, user.id, bot)
    return Response.json({ bot: detail }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[openlink-bots] detail failed', error)
    return errorResponse('BOT_READ_FAILED', 502)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
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
  try {
    const updated = await updateBot(supabase, user.id, bot, {
      name: body.name,
      description: body.description,
      avatarShape: body.avatarShape,
      avatarColor: body.avatarColor,
      avatarPngBase64: body.avatarPngBase64,
      model: body.model,
    })
    return Response.json({ bot: updated }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof BotInputError) return errorResponse(error.message, 400)
    console.error('[openlink-bots] update failed', error)
    return errorResponse('BOT_UPDATE_FAILED', 502)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return errorResponse('BOT_NOT_FOUND', 404)
  try {
    await deleteBot(supabase, user.id, bot)
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[openlink-bots] delete failed', error)
    return errorResponse('BOT_DELETE_FAILED', 502)
  }
}
