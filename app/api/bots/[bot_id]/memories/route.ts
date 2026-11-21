import { getBot } from '@/lib/bots'
import {
  clearBotAgentMemories,
  deleteBotAgentMemory,
  getBotAgentMemories,
  isMissingWorkHostAgentError,
  WorkHostError,
} from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function botForRequest(botId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: errorResponse('AUTH_REQUIRED', 401) } as const
  const bot = await getBot(supabase, user.id, botId)
  if (!bot) return { error: errorResponse('BOT_NOT_FOUND', 404) } as const
  return { bot } as const
}

/** The facts Work-host remembers about this Bot's user and work. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const resolved = await botForRequest(botId)
  if ('error' in resolved) return resolved.error
  try {
    const memories = await getBotAgentMemories(resolved.bot.workAgentId)
    return Response.json({ memories }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof WorkHostError && isMissingWorkHostAgentError(error)) {
      return Response.json({ memories: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }
    console.error('[openlink-bots] memories read failed', error)
    return errorResponse('BOT_MEMORIES_READ_FAILED', 502, true)
  }
}

/** Remove one remembered fact, or clear the Bot's memory. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const resolved = await botForRequest(botId)
  if ('error' in resolved) return resolved.error

  let body: { memoryId?: unknown; all?: unknown }
  try {
    body = await request.json() as { memoryId?: unknown; all?: unknown }
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }
  const all = body.all === true
  const memoryId = typeof body.memoryId === 'string' ? body.memoryId.trim() : ''
  if (!all && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(memoryId)) {
    return errorResponse('INVALID_BODY', 400)
  }

  try {
    if (all) await clearBotAgentMemories(resolved.bot.workAgentId)
    else await deleteBotAgentMemory(resolved.bot.workAgentId, memoryId)
  } catch (error) {
    if (error instanceof WorkHostError) {
      if (isMissingWorkHostAgentError(error)) return errorResponse('BOT_RUNTIME_NOT_READY', 409, true)
      return errorResponse(error.status >= 500 ? 'BOT_MEMORIES_WRITE_FAILED' : error.message, error.status, error.status >= 500)
    }
    console.error('[openlink-bots] memories write failed', error)
    return errorResponse('BOT_MEMORIES_WRITE_FAILED', 502, true)
  }
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
