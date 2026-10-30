import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { findFirstPersistedUserMessage, loadPiSessionSnapshot } from '@/lib/chat-session-persistence.server'
import { resolveAgentProviderRuntimeConfiguration } from '@/lib/ai-provider-configurations.server'
import { cloudComputerSdkRequest } from '@/lib/platform-cloud-host.server'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

/** Ensures the session Agent is ready and returns its display-safe native resources. */
export async function GET(_request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  const cloudMode = getRuntimeMode() === 'cloud'
  const host = agentHostConfig()
  if (!cloudMode && !host) return Response.json({ error: 'AGENT_HOST_NOT_CONFIGURED' }, { status: 503 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })

  if (cloudMode) {
    let hasFirstMessage = false
    try {
      hasFirstMessage = Boolean(await findFirstPersistedUserMessage(supabase, user.id, sessionId))
    } catch {
      return Response.json({ error: 'SESSION_EVENTS_READ_FAILED' }, { status: 503 })
    }
    if (!hasFirstMessage) {
      const agent = session.agent ?? 'pi'
      return Response.json({
        agent,
        source: agent === 'omp' ? 'Oh My Pi RPC' : 'Pi RPC',
        accessMode: 'restricted',
        mcpServers: [],
        imageGeneration: false,
        commands: [],
        models: [],
        awaitingFirstMessage: true,
      }, { headers: { 'Cache-Control': 'no-store' } })
    }
    let runtimeConfiguration
    try {
      runtimeConfiguration = await resolveAgentProviderRuntimeConfiguration(
        supabase,
        user.id,
        session.provider_id && session.model_id
          ? { providerId: session.provider_id, modelId: session.model_id }
          : null,
      )
    } catch {
      return Response.json({ error: 'MODEL_CONFIGURATION_INVALID' }, { status: 400 })
    }
    if (!runtimeConfiguration) return Response.json({ error: 'MODEL_CONFIGURATION_REQUIRED' }, { status: 400 })
    try {
      const upstream = await cloudComputerSdkRequest(session.project_id, `/v1/agent/sessions/${sessionId}/resources`, {
        sessionId,
        workspaceId: session.workspace_id,
        agent: session.agent,
        model: { providerId: runtimeConfiguration.providerId, modelId: runtimeConfiguration.modelId },
        runtimeConfiguration,
      }, AbortSignal.timeout(90_000))
      const payload = await upstream.json().catch(() => null) as Record<string, unknown> | null
      if (!upstream.ok || !payload) return Response.json({ error: 'RUNTIME_NOT_READY' }, { status: upstream.status })
      const commands = Array.isArray(payload.commands) ? payload.commands.flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const command = value as Record<string, unknown>
        return typeof command.name === 'string'
          ? [{ name: command.name.slice(0, 80), description: typeof command.description === 'string' ? command.description.slice(0, 256) : '', source: typeof command.source === 'string' ? command.source.slice(0, 32) : 'builtin' }]
          : []
      }) : []
      return Response.json({
        agent: session.agent,
        source: typeof payload.source === 'string' ? payload.source : `${session.agent === 'omp' ? 'Oh My Pi' : 'Pi'} Resource Loader`,
        accessMode: 'restricted',
        mcpServers: [],
        imageGeneration: false,
        commands,
        models: [],
      }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : ''
      const allowedCodes = new Set(['CLOUD_CONNECTION_NOT_CONFIGURED', 'CLOUD_CONNECTION_INACTIVE', 'CLOUD_CONNECTION_REAUTH_REQUIRED', 'CLOUD_COMPUTER_UNAVAILABLE', 'CLOUD_COMPUTER_PERMISSION_REQUIRED', 'CLOUD_PROJECT_NOT_LINKED', 'CLOUD_PROJECT_NOT_ACCESSIBLE', 'CLOUD_SDK_HOST_NOT_CONFIGURED', 'COMPUTER_AGENT_CAPABILITY_REQUIRED', 'COMPUTER_AGENT_UNAVAILABLE'])
      return Response.json({ error: allowedCodes.has(rawCode) ? rawCode : 'RUNTIME_NOT_READY' }, {
        status: typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 502,
      })
    }
  }
  if (!host) return Response.json({ error: 'AGENT_HOST_NOT_CONFIGURED' }, { status: 503 })

  let runtimeConfiguration
  try {
    runtimeConfiguration = await resolveAgentProviderRuntimeConfiguration(
      supabase,
      user.id,
      session.provider_id && session.model_id
        ? { providerId: session.provider_id, modelId: session.model_id }
        : null,
    )
  } catch {
    return Response.json({ error: 'MODEL_CONFIGURATION_INVALID' }, { status: 400 })
  }
  if (!runtimeConfiguration) return Response.json({ error: 'MODEL_CONFIGURATION_REQUIRED' }, { status: 400 })
  let nativeSession
  if ((session.agent ?? 'codex') === 'pi') {
    try {
      nativeSession = await loadPiSessionSnapshot(supabase, user.id, sessionId)
    } catch {
      return Response.json({ error: 'PI_SESSION_READ_FAILED' }, { status: 500 })
    }
  }

  const upstream = await fetch(`${host.baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/resources`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: user.id,
      workspaceId: session.workspace_id,
      projectId: session.project_id,
      sessionId,
      runtimeConfiguration,
      agent: session.agent ?? 'codex',
      accessMode: session.access_mode,
      ...(nativeSession ? { nativeSession } : {}),
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(90_000),
  })
  const payload = await upstream.json().catch(() => null) as Record<string, unknown> | null
  if (!upstream.ok || !payload) return Response.json({ error: 'RUNTIME_NOT_READY' }, { status: upstream.status === 404 ? 409 : upstream.status })
  const mcpServers = Array.isArray(payload.mcpServers)
    ? payload.mcpServers.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).name === 'string'
      ? [{ id: (item as Record<string, string>).id, name: (item as Record<string, string>).name }]
      : [])
    : []
  const commands = Array.isArray(payload.commands)
    ? payload.commands.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const command = item as Record<string, unknown>
      const source = typeof command.source === 'string' && command.source.length <= 32 ? command.source : null
      return typeof command.name === 'string' && source
        ? [{ name: command.name, description: typeof command.description === 'string' ? command.description : '', source }]
        : []
    })
    : []
  return Response.json({
    agent: session.agent ?? 'codex',
    source: payload.source === 'Pi Resource Loader' ? payload.source : 'Codex App Server',
    accessMode: payload.accessMode === 'ask' || payload.accessMode === 'open' ? payload.accessMode : 'restricted',
    mcpServers,
    imageGeneration: payload.imageGeneration === true,
    commands,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
