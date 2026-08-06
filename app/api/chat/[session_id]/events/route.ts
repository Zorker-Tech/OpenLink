import { PiEventAdapter } from '@/lib/agent-runtime/pi-event-adapter'
import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { resolveAgentProviderRuntimeConfiguration } from '@/lib/ai-provider-configurations.server'
import {
  nextChatEventSequence,
  loadPiSessionSnapshot,
  parsePiSessionDelta,
  persistChatEvents,
  persistPiSessionDelta,
} from '@/lib/chat-session-persistence.server'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const encoder = new TextEncoder()

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'INVALID_SESSION' }, { status: 404 })
  const host = agentHostConfig()
  if (!host) return Response.json({ error: 'AGENT_HOST_NOT_CONFIGURED' }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })

  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })

  let body: { message?: unknown; startSequence?: unknown; model?: unknown }
  try {
    body = await request.json() as { message?: unknown; startSequence?: unknown; model?: unknown }
  } catch {
    return Response.json({ error: 'INVALID_BODY' }, { status: 400 })
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 10_000) : ''
  if (!message) return Response.json({ error: 'MESSAGE_REQUIRED' }, { status: 400 })
  let startSequence: number
  try {
    startSequence = await nextChatEventSequence(supabase, user.id, sessionId)
  } catch {
    return Response.json({ error: 'SESSION_EVENTS_READ_FAILED' }, { status: 500 })
  }

  let requestedModel: { providerId: string; modelId: string } | null = session.provider_id && session.model_id
    ? { providerId: session.provider_id, modelId: session.model_id }
    : null
  if (body.model !== undefined) {
    if (!body.model || typeof body.model !== 'object') return Response.json({ error: 'INVALID_MODEL' }, { status: 400 })
    const candidate = body.model as Record<string, unknown>
    if (typeof candidate.providerId !== 'string' || typeof candidate.modelId !== 'string') return Response.json({ error: 'INVALID_MODEL' }, { status: 400 })
    requestedModel = { providerId: candidate.providerId, modelId: candidate.modelId }
  }

  let runtimeConfiguration
  try {
    runtimeConfiguration = await resolveAgentProviderRuntimeConfiguration(supabase, user.id, requestedModel)
  } catch (error) {
    return Response.json({ error: 'MODEL_CONFIGURATION_INVALID', detail: error instanceof Error ? error.message : 'UNKNOWN_ERROR' }, { status: 400 })
  }
  if (!runtimeConfiguration) {
    return Response.json({ error: 'MODEL_CONFIGURATION_REQUIRED' }, { status: 400 })
  }

  const { error: touchError } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .update({
      provider_id: runtimeConfiguration.providerId,
      model_id: runtimeConfiguration.modelId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    .eq('user_id', user.id)
  if (touchError) return Response.json({ error: 'SESSION_UPDATE_FAILED' }, { status: 500 })

  let nativeSession
  try {
    nativeSession = await loadPiSessionSnapshot(supabase, user.id, sessionId)
  } catch {
    return Response.json({ error: 'PI_SESSION_READ_FAILED' }, { status: 500 })
  }

  const upstream = await fetch(`${host.baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: user.id,
      workspaceId: session.workspace_id,
      projectId: session.project_id,
      message,
      runtimeConfiguration,
      ...(nativeSession ? { nativeSession } : {}),
    }),
    cache: 'no-store',
  })
  if (!upstream.ok || !upstream.body) {
    const payload = await upstream.text().catch(() => '')
    return Response.json({ error: 'AGENT_HOST_FAILED', detail: payload.slice(0, 2_000) }, { status: upstream.status || 502 })
  }

  const adapter = new PiEventAdapter(sessionId, () => new Date().toISOString(), startSequence)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // Keep persistence ordered, but never make the browser wait for a
      // Postgres round-trip before it receives the next agent event. The
      // previous implementation awaited every insert inside this loop, which
      // turned a token stream into a sequence of database-paced blocks.
      let persistenceQueue = Promise.resolve()
      let pendingChatEvents: OpenLinkAgentEvent[] = []
      const queuePersistence = (operation: () => Promise<void>) => {
        persistenceQueue = persistenceQueue.then(operation)
      }
      const queueChatEvents = (events: OpenLinkAgentEvent[]) => {
        if (!events.length) return
        pendingChatEvents.push(...events)
        if (pendingChatEvents.length < 32) return
        const batch = pendingChatEvents.splice(0)
        queuePersistence(() => persistChatEvents(supabase, user.id, sessionId, batch))
      }
      const flushChatEvents = () => {
        if (!pendingChatEvents.length) return
        const batch = pendingChatEvents.splice(0)
        queuePersistence(() => persistChatEvents(supabase, user.id, sessionId, batch))
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          if (buffer.length > 1024 * 1024) throw new Error('Pi RPC frame exceeds the configured limit')
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line) {
              const frame = JSON.parse(line) as unknown
              const piSessionDelta = parsePiSessionDelta(frame)
              if (piSessionDelta) {
                queuePersistence(() => persistPiSessionDelta(supabase, user.id, sessionId, piSessionDelta))
              } else {
                const events = adapter.adapt(frame)
                const completedEvents = events.filter((event) => event.type === 'session.completed')
                const liveEvents = events.filter((event) => event.type !== 'session.completed')
                for (const event of liveEvents) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
                queueChatEvents(liveEvents)
                if (completedEvents.length) {
                  // A session completion is the durable boundary. Stream all
                  // prior deltas immediately, then wait only here so a user
                  // who leaves and reopens the session never sees a partial
                  // final turn.
                  queueChatEvents(completedEvents)
                  flushChatEvents()
                  await persistenceQueue
                  for (const event of completedEvents) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
                }
              }
            }
            newline = buffer.indexOf('\n')
          }
          if (done) break
        }
        if (buffer.trim()) throw new Error('Pi RPC stream ended mid-frame')
        flushChatEvents()
        // The session.completed barrier above protects UI events. Drain the
        // final Pi-native snapshot as well before closing the response.
        await persistenceQueue
        controller.close()
      } catch (error) {
        flushChatEvents()
        controller.error(error)
      } finally {
        void persistenceQueue.catch((error) => {
          console.error('OpenLink chat event persistence failed', error)
        })
        reader.releaseLock()
      }
    },
    cancel() {
      void upstream.body?.cancel()
    },
  })

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
      'X-OpenLink-Agent-Transport': 'pi-rpc',
    },
  })
}
