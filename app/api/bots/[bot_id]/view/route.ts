import { getBot, markBotViewed } from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return Response.json({ error: { code: 'BOT_NOT_FOUND' } }, { status: 404 })
  await markBotViewed(supabase, user.id, bot.id)
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
