import { randomUUID } from 'node:crypto'
import { BotEventAccumulator, type BotStreamUpdate, type BotTranscriptEntry } from '@/lib/bot-transcript'
import { appendBotEntries, appendBotUserMessage, ensureBotRuntimeProjection, getBot, isBotRuntimeSessionForBot, updateBotRuntimeState } from '@/lib/bots'
import { isOpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { handleChatSessionEvents } from '@/lib/chat-session-events.server'
import { getBotChatSession } from '@/lib/chat-sessions'
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

function streamFailure(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  bot: Awaited<ReturnType<typeof getBot>> & {},
  userEntry: BotTranscriptEntry,
  code: string,
  error: unknown,
) {
  void updateBotRuntimeState(supabase, userId, bot.id, { status: 'failed', error: code }).catch((stateError) => {
    console.error('[openlink-bots] runtime failure state could not be recorded', stateError)
  })
  const failure = failedActivity(code)
  void appendBotEntries(supabase, userId, bot, [failure]).catch((appendError) => {
    console.error('[openlink-bots] runtime failure transcript write failed', appendError)
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ type: 'entry', entry: userEntry }))
      controller.enqueue(frame({ type: 'entry', entry: failure }))
      controller.enqueue(frame({ type: 'pending', pending: null }))
      controller.enqueue(frame({ type: 'error', message: code }))
      controller.enqueue(frame({ type: 'done' }))
      controller.close()
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
  if (!bot.runtimeSessionId) return errorResponse('BOT_RUNTIME_NOT_READY', 409, true)

  let body: { message?: unknown }
  try {
    body = await request.json() as { message?: unknown }
  } catch {
    return errorResponse('INVALID_BODY', 400)
  }
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 10_000) : ''
  if (!message) return errorResponse('MESSAGE_REQUIRED', 400)

  let userEntry: BotTranscriptEntry
  try {
    userEntry = await appendBotUserMessage(supabase, user.id, bot, message)
  } catch (error) {
    console.error('[openlink-bots] user message persistence failed', error)
    return errorResponse('BOT_TRANSCRIPT_WRITE_FAILED', 502, true)
  }

  const runtimeSession = await getBotChatSession(supabase, user.id, bot.runtimeSessionId)
  if (!runtimeSession || !isBotRuntimeSessionForBot(bot, runtimeSession)) {
    return streamFailure(supabase, user.id, bot, userEntry, 'BOT_RUNTIME_NOT_READY', new Error('BOT_RUNTIME_NOT_READY'))
  }

  let upstream: Response
  try {
    upstream = await handleChatSessionEvents(new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, requestKind: 'message' }),
      signal: request.signal,
    }), {
      sessionId: bot.runtimeSessionId,
      session: runtimeSession,
      userId: user.id,
    })
  } catch (error) {
    console.error('[openlink-bots] runtime request failed', error)
    return streamFailure(supabase, user.id, bot, userEntry, 'BOT_RUNTIME_UNAVAILABLE', error)
  }

  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => null) as { error?: unknown } | null
    const code = typeof payload?.error === 'string'
      ? payload.error
      : payload?.error && typeof payload.error === 'object' && 'code' in payload.error
        ? String((payload.error as { code?: unknown }).code ?? 'BOT_RUNTIME_FAILED')
        : 'BOT_RUNTIME_FAILED'
    return streamFailure(supabase, user.id, bot, userEntry, code, new Error(code))
  }
  if (!upstream.body) return streamFailure(supabase, user.id, bot, userEntry, 'BOT_RUNTIME_UNAVAILABLE', new Error('BOT_RUNTIME_UNAVAILABLE'))

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(frame({ type: 'entry', entry: userEntry }))
      controller.enqueue(frame({ type: 'pending', pending: { label: 'Working', showLabel: true } }))

      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      const accumulator = new BotEventAccumulator()
      let buffer = ''
      let pending: BotTranscriptEntry[] = []

      const flush = async () => {
        if (!pending.length) return
        const batch = pending
        pending = []
        try {
          await appendBotEntries(supabase, user.id, bot, batch)
        } catch (error) {
          console.error('[openlink-bots] transcript mirror failed', error)
        }
      }

      const handleLine = async (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let event: unknown
        try {
          event = JSON.parse(trimmed) as unknown
        } catch {
          return
        }
        if (!isOpenLinkAgentEvent(event) || event.type === 'message.user') return
        const result = accumulator.consume(event)
        for (const update of result.updates) controller.enqueue(frame(update))
        pending.push(...result.persisted)
        if (result.persisted.length || result.updates.some((update) => update.type === 'pending' && update.pending === null)) {
          await flush()
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) await handleLine(line)
        }
        buffer += decoder.decode()
        if (buffer.trim()) await handleLine(buffer)
        const buffered = accumulator.flush()
        if (buffered.length) {
          pending.push(...buffered)
          for (const entry of buffered) controller.enqueue(frame({ type: 'entry', entry }))
        }
        await flush()
        controller.enqueue(frame({ type: 'pending', pending: null }))
        controller.enqueue(frame({ type: 'done' }))
      } catch (error) {
        const failure = failedActivity(error instanceof Error ? error.message : 'Runtime stream failed')
        await appendBotEntries(supabase, user.id, bot, [failure]).catch(() => undefined)
        controller.enqueue(frame({ type: 'entry', entry: failure }))
        controller.enqueue(frame({ type: 'pending', pending: null }))
        controller.enqueue(frame({ type: 'error', message: 'BOT_RUNTIME_STREAM_FAILED' }))
      } finally {
        try { reader.releaseLock() } catch {}
        controller.close()
      }
    },
    cancel() {
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
