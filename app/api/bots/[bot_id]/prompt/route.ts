import { randomUUID } from 'node:crypto'
import type { BotStreamUpdate, BotTranscriptEntry } from '@/lib/bot-transcript'
import { botUpdatesFromWorkHostFrame } from '@/lib/bot-work-host-stream'
import { ensureBotRuntimeProjection, getBot } from '@/lib/bots'
import { BotRuntimeError, streamBotPrompt, warmBotRuntime } from '@/lib/bot-runtime.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 1_800

const encoder = new TextEncoder()

function errorResponse(code: string, status: number, retryable = false) {
  return Response.json({ error: { code, message: code, retryable } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function frame(update: BotStreamUpdate): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(update)}\n\n`)
}

function failedActivity(message: string): BotTranscriptEntry {
  return {
    kind: 'activity',
    id: `bot-error-${randomUUID()}`,
    timestampMs: Date.now(),
    activity: {
      label: 'The turn could not finish',
      detail: message.slice(0, 2000),
      tool: 'error',
      status: 'failed',
    },
  }
}

/**
 * A Bot turn enters through Work-host. The durable acceptance, transcript,
 * run queue and settlement all belong to Work-host; this route only projects
 * the Bot's frames into the surface's stream vocabulary. It never calls the
 * Code session lease, the Code event handler or a hidden chat session.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ bot_id: string }> },
) {
  const { bot_id: botId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorResponse('AUTH_REQUIRED', 401)
  const found = await getBot(supabase, user.id, botId)
  if (!found) return errorResponse('BOT_NOT_FOUND', 404)

  let bot: NonNullable<Awaited<ReturnType<typeof getBot>>>
  try {
    bot = await ensureBotRuntimeProjection(supabase, user.id, found)
  } catch (error) {
    console.error('[openlink-bots] runtime projection recovery failed', error)
    return errorResponse('BOT_PROJECTION_RECOVERY_FAILED', 503, true)
  }
  if (!bot.runtimeKey) return errorResponse('BOT_RUNTIME_NOT_READY', 409, true)

  // A group has no sandbox of its own: each member runs in its own Bot box.
  // Warm the members before dispatch so a group turn never starts a member
  // whose worker is missing. One unavailable member is a pass, not a reason
  // to block the rest of the group.
  if (bot.kind === 'bot') {
    // A turn must not be durably accepted without a live Bot binding. The
    // ensure is idempotent and also refreshes a binding left stale by a
    // substrate or Work-host restart, so it runs before every prompt rather
    // than only when the projection looks cold.
    try {
      await warmBotRuntime(supabase, user.id, bot)
    } catch (error) {
      if (error instanceof BotRuntimeError) return errorResponse(error.code, error.status, error.retryable)
      console.error('[openlink-bots] Bot runtime ensure before prompt failed', error)
      return errorResponse('BOT_RUNTIME_UNAVAILABLE', 503, true)
    }
  }
  if (bot.kind === 'group') {
    const results = await Promise.allSettled(bot.memberIds.map(async (memberId) => {
      const member = await getBot(supabase, user.id, memberId)
      if (!member || member.kind !== 'bot') return
      const projected = await ensureBotRuntimeProjection(supabase, user.id, member)
      await warmBotRuntime(supabase, user.id, projected)
    }))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    for (const failure of failures) {
      console.error('[openlink-bots] group member runtime warmup failed', failure.reason)
    }
    if (failures.length === results.length) {
      return errorResponse('BOT_GROUP_MEMBERS_UNAVAILABLE', 503, true)
    }
  }

  let body: { message?: unknown; clientNonce?: unknown }
  try {
    body = await request.json() as { message?: unknown; clientNonce?: unknown }
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 10_000) : ''
  if (!message) return errorResponse('MESSAGE_REQUIRED', 400)
  const clientNonce = typeof body.clientNonce === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(body.clientNonce)
    ? body.clientNonce
    : undefined

  let upstream: Response
  try {
    upstream = await streamBotPrompt(bot, message, clientNonce)
  } catch (error) {
    if (error instanceof BotRuntimeError) return errorResponse(error.code, error.status, error.retryable)
    console.error('[openlink-bots] Bot turn acceptance failed', error)
    return errorResponse('BOT_RUNTIME_UNAVAILABLE', 503, true)
  }
  if (!upstream.body) return errorResponse('BOT_RUNTIME_UNAVAILABLE', 502, true)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let terminal = false

      const handleLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let event: unknown
        try {
          event = JSON.parse(trimmed) as unknown
        } catch {
          return
        }
        for (const update of botUpdatesFromWorkHostFrame(event)) {
          controller.enqueue(frame(update))
          if (update.type === 'done') terminal = true
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) handleLine(line)
        }
        buffer += decoder.decode()
        if (buffer.trim()) handleLine(buffer)
        if (!terminal) {
          controller.enqueue(frame({ type: 'pending', pending: null }))
          controller.enqueue(frame({ type: 'done' }))
        }
      } catch (error) {
        const failure = failedActivity(error instanceof Error ? error.message : 'Bot turn stream failed')
        controller.enqueue(frame({ type: 'entry', entry: failure }))
        controller.enqueue(frame({ type: 'pending', pending: null }))
        controller.enqueue(frame({ type: 'error', message: 'BOT_RUNTIME_STREAM_FAILED' }))
        controller.enqueue(frame({ type: 'done' }))
      } finally {
        try { reader.releaseLock() } catch {}
        controller.close()
      }
    },
    cancel() {
      // The turn is durable in Work-host. A closed browser tab stops this
      // projection; it does not cancel the Bot's work.
      void upstream.body?.cancel().catch(() => undefined)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
