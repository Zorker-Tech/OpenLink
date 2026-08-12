import { PiEventAdapter } from '@/lib/agent-runtime/pi-event-adapter'
import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { randomBytes } from 'node:crypto'
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
const CHAT_SESSION_LEASE_TTL_SECONDS = 1_800
const CHAT_SESSION_LEASE_HEARTBEAT_MS = 60_000

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

  let body: { message?: unknown; startSequence?: unknown; model?: unknown; browserSessionId?: unknown }
  try {
    body = await request.json() as { message?: unknown; startSequence?: unknown; model?: unknown }
  } catch {
    return Response.json({ error: 'INVALID_BODY' }, { status: 400 })
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 10_000) : ''
  if (!message) return Response.json({ error: 'MESSAGE_REQUIRED' }, { status: 400 })
  const browserSessionId = body.browserSessionId === undefined
    ? undefined
    : typeof body.browserSessionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(body.browserSessionId)
      ? body.browserSessionId
      : null
  if (body.browserSessionId !== undefined && !browserSessionId) return Response.json({ error: 'INVALID_BROWSER_SESSION' }, { status: 400 })
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
    const code = error instanceof Error ? error.message : ''
    // Provider/configuration errors can contain PostgREST or crypto details;
    // return only the small set of UI-safe machine codes.
    const safeCode = code === 'PROVIDER_CREDENTIAL_REKEY_REQUIRED'
      ? code
      : code === 'PROVIDER_API_KEY_REQUIRED' || code === 'MODEL_NOT_ENABLED' || code === 'UNKNOWN_PROVIDER_MODEL' || code === 'UNKNOWN_PROVIDER'
        ? code
        : 'MODEL_CONFIGURATION_INVALID'
    return Response.json({ error: safeCode }, { status: 400 })
  }
  if (!runtimeConfiguration) {
    return Response.json({ error: 'MODEL_CONFIGURATION_REQUIRED' }, { status: 400 })
  }

  const leaseHolder = randomBytes(24).toString('base64url')
  const { data: leaseAcquired, error: leaseError } = await supabase
    .schema('openlink')
    .rpc('acquire_chat_session_lease', {
      p_session_id: sessionId,
      p_user_id: user.id,
      p_holder_id: leaseHolder,
      p_ttl_seconds: CHAT_SESSION_LEASE_TTL_SECONDS,
    })
  if (leaseError) return Response.json({ error: 'SESSION_LEASE_FAILED' }, { status: 503 })
  if (leaseAcquired !== true) return Response.json({ error: 'SESSION_BUSY', retryable: true }, { status: 409 })
  let leaseReleased = false
  const releaseLease = async () => {
    if (leaseReleased) return
    leaseReleased = true
    const { error } = await supabase
      .schema('openlink')
      .rpc('release_chat_session_lease', {
        p_session_id: sessionId,
        p_user_id: user.id,
        p_holder_id: leaseHolder,
      })
    if (error) console.error('OpenLink chat session lease release failed', error)
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
  if (touchError) {
    await releaseLease()
    return Response.json({ error: 'SESSION_UPDATE_FAILED' }, { status: 500 })
  }

  let nativeSession
  try {
    nativeSession = await loadPiSessionSnapshot(supabase, user.id, sessionId)
  } catch {
    await releaseLease()
    return Response.json({ error: 'PI_SESSION_READ_FAILED' }, { status: 500 })
  }

  // Reserve the stream's sequence range only after body/model/session
  // validation succeeds. Invalid requests should not consume a million-event range or
  // create an event-counter row for a session that never reaches Agent Host.
  let startSequence: number
  try {
    startSequence = await nextChatEventSequence(supabase, user.id, sessionId)
  } catch {
    await releaseLease()
    return Response.json({ error: 'SESSION_EVENTS_READ_FAILED' }, { status: 500 })
  }

  // The user message is part of the durable turn boundary, not something that
  // should depend on Pi reaching its first `message_start` frame. Persist it
  // before contacting Agent Host so a provider outage or a provisioning error
  // cannot make the user's just-sent message disappear on reopen.
  const canonicalUserEvent: OpenLinkAgentEvent = {
    version: 1,
    id: `${sessionId}:${startSequence}`,
    sequence: startSequence,
    sessionId,
    timestamp: new Date().toISOString(),
    source: 'pi',
    type: 'message.user',
    messageId: `${sessionId}:user:${startSequence}`,
    text: message,
  }
  try {
    await persistChatEvents(supabase, user.id, sessionId, [canonicalUserEvent])
  } catch {
    await releaseLease()
    return Response.json({ error: 'SESSION_EVENTS_WRITE_FAILED' }, { status: 500 })
  }
  const persistTerminalFailure = async (messageText: string) => {
    const failure = new PiEventAdapter(sessionId, () => new Date().toISOString(), startSequence + 1)
      .adapt({ type: 'extension_error', error: messageText })
      .find((event): event is OpenLinkAgentEvent => event.type === 'error')
    if (!failure) return
    await persistChatEvents(supabase, user.id, sessionId, [failure])
  }

  const upstreamAbortController = new AbortController()
  // Keep the BFF↔Agent Host stream alive briefly after the browser disconnects
  // so the worker can flush its Pi-native JSONL delta. Cancellation is sent to
  // Agent Host through its authenticated control endpoint; aborting this fetch
  // immediately would discard the final snapshot and make the next reopen
  // appear to have lost the turn.
  const upstreamSignal = upstreamAbortController.signal
  let clientDisconnected = false
  let upstreamReady = false
  let cancellationSent = false
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  const cancelAgentPrompt = () => {
    if (cancellationSent) return
    cancellationSent = true
    void fetch(`${host.baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, workspaceId: session.workspace_id, projectId: session.project_id, sessionId }),
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    }).catch((error) => {
      console.error('OpenLink Agent cancellation request failed', error)
    })
  }
  const scheduleClientDrain = () => {
    cancelAgentPrompt()
    if (drainTimer !== null) return
    // A canceled Pi prompt normally emits its native-session delta within a
    // few seconds. Bound the drain so a wedged worker cannot hold a lease
    // forever after the user leaves the page.
    drainTimer = setTimeout(() => {
      drainTimer = null
      upstreamAbortController.abort()
    }, 15_000)
    drainTimer.unref?.()
  }
  const onRequestAbort = () => {
    clientDisconnected = true
    // Send cancellation even if Agent Host is still provisioning. Its close
    // safety timer covers the small race before the active worker controller
    // is registered.
    cancelAgentPrompt()
    if (!upstreamReady) upstreamAbortController.abort()
    else scheduleClientDrain()
  }
  request.signal.addEventListener('abort', onRequestAbort, { once: true })
  if (request.signal.aborted) onRequestAbort()
  let upstream: Response
  try {
    upstream = await fetch(`${host.baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host.apiToken}`,
        'Content-Type': 'application/json',
        'X-OpenLink-Drain-On-Close': '1',
      },
      body: JSON.stringify({
        userId: user.id,
        workspaceId: session.workspace_id,
        projectId: session.project_id,
        message,
        runtimeConfiguration,
        ...(browserSessionId ? { browserSessionId } : {}),
        ...(nativeSession ? { nativeSession } : {}),
      }),
      signal: upstreamSignal,
      cache: 'no-store',
    })
  } catch {
    request.signal.removeEventListener('abort', onRequestAbort)
    if (drainTimer !== null) clearTimeout(drainTimer)
    await persistTerminalFailure(request.signal.aborted
      ? 'Agent request was canceled before the worker started'
      : 'Agent Host was unavailable before the worker started').catch((error) => {
      console.error('OpenLink failed to persist pre-stream Agent error', error)
    })
    await releaseLease()
    return Response.json({ error: 'AGENT_HOST_UNAVAILABLE', retryable: true }, { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    // Agent Host diagnostics can contain provider responses or provisioning
    // details that are not safe to reflect into the browser. Preserve only a
    // bounded machine-readable code; operators can inspect the Agent Host
    // logs with the request/session id.
    const payload = await upstream.json().catch(() => null) as { error?: { code?: unknown; retryable?: unknown } } | null
    const code = typeof payload?.error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(payload.error.code)
      ? payload.error.code
      : 'AGENT_HOST_FAILED'
    request.signal.removeEventListener('abort', onRequestAbort)
    if (drainTimer !== null) clearTimeout(drainTimer)
    await persistTerminalFailure('Agent Host failed before the worker stream started').catch((error) => {
      console.error('OpenLink failed to persist Agent Host failure', error)
    })
    await releaseLease()
    return Response.json({ error: 'AGENT_HOST_FAILED', code, retryable: payload?.error?.retryable === true }, { status: upstream.status || 502 })
  }
  upstreamReady = true
  if (clientDisconnected) scheduleClientDrain()

  // Leave the first reserved sequence to the canonical user event above.
  const adapter = new PiEventAdapter(sessionId, () => new Date().toISOString(), startSequence + 1)
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let leaseHeartbeat: ReturnType<typeof setInterval> | null = null
  let leaseRenewalFailure: Error | null = null
  let leaseRenewing = false
  const cancelUpstream = () => {
    upstreamAbortController.abort()
    if (activeReader) {
      void activeReader.cancel().catch(() => undefined)
    } else {
      void upstream.body?.cancel().catch(() => undefined)
    }
  }
  const stopLeaseHeartbeat = () => {
    if (leaseHeartbeat !== null) {
      clearInterval(leaseHeartbeat)
      leaseHeartbeat = null
    }
  }
  const renewLease = async () => {
    if (leaseReleased || leaseRenewalFailure || leaseRenewing) return
    leaseRenewing = true
    try {
      const { data, error } = await supabase
        .schema('openlink')
        .rpc('renew_chat_session_lease', {
          p_session_id: sessionId,
          p_user_id: user.id,
          p_holder_id: leaseHolder,
          p_ttl_seconds: CHAT_SESSION_LEASE_TTL_SECONDS,
        })
      // A normal stream completion may release the lease while this network
      // round-trip is in flight. That is not a renewal failure.
      if (leaseReleased) return
      if (error || data !== true) {
        leaseRenewalFailure = new Error('SESSION_LEASE_LOST')
        console.error('OpenLink chat session lease renewal failed', error ?? 'lease is no longer held')
        cancelUpstream()
      }
    } finally {
      leaseRenewing = false
    }
  }
  const startLeaseHeartbeat = () => {
    if (leaseHeartbeat !== null) return
    leaseHeartbeat = setInterval(() => { void renewLease() }, CHAT_SESSION_LEASE_HEARTBEAT_MS)
    leaseHeartbeat.unref?.()
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      startLeaseHeartbeat()
      const reader = upstream.body!.getReader()
      activeReader = reader
      const decoder = new TextDecoder()
      let buffer = ''
      // Keep persistence ordered, but never make the browser wait for a
      // Postgres round-trip before it receives the next agent event. The
      // previous implementation awaited every insert inside this loop, which
      // turned a token stream into a sequence of database-paced blocks.
      let persistenceQueue = Promise.resolve()
      let persistenceFailure: unknown
      let pendingChatEvents: OpenLinkAgentEvent[] = []
      // Pi emits agent_settled before the worker writes the final native
      // session delta. Hold the UI completion event until the whole upstream
      // stream has been consumed and both event and Pi-session persistence have
      // drained; otherwise a fast reopen can observe "completed" with no
      // durable Pi entries yet.
      let pendingCompletedEvents: OpenLinkAgentEvent[] = []
      let errorEventSeen = false
      const emitSyntheticError = (message: string) => {
        if (errorEventSeen) return
        const event = adapter.adapt({ type: 'extension_error', error: message })[0]
        if (!event || event.type !== 'error') return
        errorEventSeen = true
        queueChatEvents([event])
        if (!clientDisconnected) {
          try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) } catch {}
        }
      }
      const queuePersistence = (operation: () => Promise<void>) => {
        persistenceQueue = persistenceQueue.then(operation).catch((error) => {
          persistenceFailure ??= error
          throw error
        })
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
        if (request.signal.aborted && !clientDisconnected) throw new Error('REQUEST_ABORTED')
        controller.enqueue(encoder.encode(`${JSON.stringify(canonicalUserEvent)}\n`))
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
                if (events.some((event) => event.type === 'error')) errorEventSeen = true
                const completedEvents = events.filter((event) => event.type === 'session.completed')
                const liveEvents = events.filter((event) => event.type !== 'session.completed')
                for (const event of liveEvents) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
                queueChatEvents(liveEvents)
                if (completedEvents.length) {
                  pendingCompletedEvents.push(...completedEvents)
                }
              }
            }
            newline = buffer.indexOf('\n')
          }
          if (done) break
        }
        if (buffer.trim()) throw new Error('Pi RPC stream ended mid-frame')
        if (!pendingCompletedEvents.length && !errorEventSeen) {
          emitSyntheticError(clientDisconnected
            ? 'Agent request was canceled before the worker reported a terminal state'
            : 'Agent worker ended before reporting a terminal state')
        }
        queueChatEvents(pendingCompletedEvents)
        flushChatEvents()
        // The completion event is the durable boundary. Drain the final
        // Pi-native snapshot and all chat events before exposing it to the UI.
        await persistenceQueue
        for (const event of pendingCompletedEvents) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        controller.close()
      } catch (error) {
        if (!leaseRenewalFailure && !persistenceFailure && !errorEventSeen) {
          emitSyntheticError(error instanceof Error && error.message === 'REQUEST_ABORTED'
            ? 'Agent request was canceled'
            : 'Agent worker stream failed before reporting a terminal state')
        }
        flushChatEvents()
        if (leaseRenewalFailure) {
          controller.error(leaseRenewalFailure)
        } else if (persistenceFailure) {
          console.error('OpenLink chat event persistence failed', persistenceFailure)
          controller.error(new Error('CHAT_PERSISTENCE_FAILED'))
        } else {
          controller.error(error)
        }
      } finally {
        stopLeaseHeartbeat()
        request.signal.removeEventListener('abort', onRequestAbort)
        if (drainTimer !== null) {
          clearTimeout(drainTimer)
          drainTimer = null
        }
        // Do not hand the session to a new prompt while already-received Pi
        // or UI events are still waiting on PostgreSQL. This is especially
        // important when the browser cancels a stream after seeing the first
        // tokens: releasing first would let the next prompt race the old
        // persistence queue and overwrite the native session header.
        await persistenceQueue.catch((error) => {
          console.error('OpenLink chat event persistence failed during cleanup', error)
        })
        await releaseLease()
        reader.releaseLock()
        activeReader = null
      }
    },
    cancel() {
      if (!clientDisconnected) {
        clientDisconnected = true
        scheduleClientDrain()
      }
      stopLeaseHeartbeat()
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
