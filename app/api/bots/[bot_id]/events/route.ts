import type { BotStreamUpdate } from '@/lib/bot-transcript'
import { botUpdatesFromWorkHostFrame } from '@/lib/bot-work-host-stream'
import { getBot } from '@/lib/bots'
import { workHostConfig } from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 3_600

const encoder = new TextEncoder()
const FORWARDED_CHANNELS = new Set(['transcript', 'outline', 'bot-turn', 'tray', 'agent-upserted'])
const HEARTBEAT_MS = 15_000

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * The same ownership filter the prompt projection uses. Work-host's event bus
 * is global, so a Bot stream must never forward another Bot's frames.
 */
function belongsToBot(frame: unknown, agentId: string): boolean {
  const record = recordOf(frame)
  if (record === null) return false
  const channel = typeof record.channel === 'string' ? record.channel : ''
  if (!FORWARDED_CHANNELS.has(channel)) return false
  const payload = recordOf(record.payload)
  if (payload === null) return false
  // A group member turn is projected through the group's transcript.
  if (channel === 'bot-turn' && payload.groupMember === true) return false
  if (payload.agentId === agentId) return true
  if (channel === 'agent-upserted') {
    const agent = recordOf(payload.agent)
    return agent?.id === agentId
  }
  if (channel === 'tray') {
    const tray = recordOf(payload.tray)
    return tray?.agentId === agentId
  }
  return false
}

/**
 * A persistent projection of one Bot's Work-host events.
 *
 * This is what makes a Bot proactive: routine runs, channel replies and any
 * other turn that was not started by this tab still reach the timeline.
 */
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
  const config = workHostConfig()
  if (!config) return new Response('Work Host is not configured', { status: 503 })

  let upstream: Response
  try {
    upstream = await fetch(`${config.baseUrl}/events?channels=transcript,outline,bot-turn,tray,agent-upserted`, {
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: 'text/event-stream',
      },
      cache: 'no-store',
      signal: request.signal,
    })
  } catch {
    return new Response('Work Host is unreachable', { status: 502 })
  }
  if (!upstream.ok || upstream.body === null) {
    await upstream.body?.cancel().catch(() => undefined)
    return new Response('Work Host rejected the event stream', { status: 502 })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let closed = false
      controller.enqueue(encoder.encode(': connected\n\n'))
      const send = (update: BotStreamUpdate) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`))
        } catch {
          closed = true
        }
      }
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          closed = true
        }
      }, HEARTBEAT_MS)
      heartbeat.unref?.()

      const handleFrame = (data: string) => {
        let frame: unknown
        try {
          frame = JSON.parse(data) as unknown
        } catch {
          return
        }
        if (!belongsToBot(frame, bot.workAgentId)) return
        for (const update of botUpdatesFromWorkHostFrame(frame)) send(update)
      }

      try {
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const event = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            for (const line of event.split('\n')) {
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (data) handleFrame(data)
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch {
        // The client disconnected or Work-host closed the stream.
      } finally {
        clearInterval(heartbeat)
        try { reader.releaseLock() } catch {}
        if (!closed) {
          closed = true
          try { controller.close() } catch {}
        }
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
