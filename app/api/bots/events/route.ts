import { proxyBotEvents } from '@/lib/bot-event-stream.server'
import { listBots, resolveBotWorkspace } from '@/lib/bots'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 3_600

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get('workspace')?.trim()
  if (!slug) return new Response(null, { status: 400 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })
  const workspace = await resolveBotWorkspace(supabase, slug)
  if (!workspace) return new Response(null, { status: 404 })
  const bots = await listBots(supabase, user.id, workspace.id)
  return proxyBotEvents(request, new Map(bots.map(bot => [bot.workAgentId, bot.id])), true)
}
