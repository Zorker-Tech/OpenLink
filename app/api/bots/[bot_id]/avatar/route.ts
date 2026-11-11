import { getBot, getBotAvatar } from '@/lib/bots'
import { fallbackBotAvatarSvg } from '@/lib/bot-avatar-fallback.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return Response.json({ error: { code: 'BOT_NOT_FOUND' } }, { status: 404 })
  const ifNoneMatch = request.headers.get('if-none-match')
  try {
    const avatar = await getBotAvatar(bot)
    if (!avatar) {
      const fallback = fallbackBotAvatarSvg(bot.name, bot.avatarColor)
      return new Response(fallback, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    if (ifNoneMatch && avatar.etag && ifNoneMatch === avatar.etag) {
      return new Response(null, { status: 304, headers: { ETag: avatar.etag, 'Cache-Control': 'private, max-age=31536000, immutable' } })
    }
    const body = new Uint8Array(avatar.bytes.byteLength)
    body.set(avatar.bytes)
    return new Response(body.buffer, {
      headers: {
        'Content-Type': avatar.contentType,
        'Content-Length': String(avatar.bytes.byteLength),
        'Cache-Control': avatar.etag ? 'private, max-age=31536000, immutable' : 'private, no-store',
        ...(avatar.etag ? { ETag: avatar.etag } : {}),
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('[openlink-bots] avatar failed', error)
    return new Response(fallbackBotAvatarSvg(bot.name, bot.avatarColor), {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
}
