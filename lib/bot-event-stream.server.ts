import 'server-only'
import type { BotStreamUpdate } from '@/lib/bot-transcript'
import { botUpdatesFromWorkHostFrame } from '@/lib/bot-work-host-stream'
import { workHostConfig } from '@/lib/work-host-client.server'

const encoder = new TextEncoder()
const FORWARDED_CHANNELS = new Set(['transcript', 'outline', 'bot-turn', 'tray', 'agent-upserted'])
const HEARTBEAT_MS = 15_000

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function agentIdFromFrame(frame: unknown): string | null {
  const record = recordOf(frame)
  if (typeof record?.channel !== 'string' || !FORWARDED_CHANNELS.has(record.channel)) return null
  const payload = recordOf(record.payload)
  if (!payload || (record.channel === 'bot-turn' && payload.groupMember === true)) return null
  const sender = record.channel === 'agent-upserted' ? recordOf(payload.agent)?.id
    : record.channel === 'tray' ? recordOf(payload.tray)?.agentId
    : payload.agentId
  return typeof sender === 'string' ? sender : null
}

export async function proxyBotEvents(
  request: Request,
  botIdsByAgent: ReadonlyMap<string, string>,
  workspace = false,
): Promise<Response> {
  const config = workHostConfig()
  if (!config) return new Response('Work Host is not configured', { status: 503 })

  const lifetime = new AbortController()
  let upstream: Response
  try {
    upstream = await fetch(`${config.baseUrl}/events?channels=transcript,outline,bot-turn,tray,agent-upserted`, {
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: 'text/event-stream',
      },
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, lifetime.signal]),
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
      const send = (botId: string, update: BotStreamUpdate) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(workspace ? { botId, update } : update)}\n\n`))
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
        const agentId = agentIdFromFrame(frame)
        const botId = agentId ? botIdsByAgent.get(agentId) : undefined
        if (botId) for (const update of botUpdatesFromWorkHostFrame(frame)) send(botId, update)
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
      lifetime.abort()
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
