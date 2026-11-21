import { proxyBotEvents } from '@/lib/bot-event-stream.server'
import { getBot } from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 3_600

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return new Response('Not found', { status: 404 })
  return proxyBotEvents(request, new Map([[bot.workAgentId, bot.id]]))
}
