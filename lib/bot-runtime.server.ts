import 'server-only'

import { resolveAgentProviderRuntimeConfiguration } from '@/lib/ai-provider-configurations.server'
import { loadPiSessionSnapshot } from '@/lib/chat-session-persistence.server'
import type { BotSummary } from '@/lib/bot-types'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

const AGENT_HOST_TIMEOUT_MS = 300_000

export class BotRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable = true,
  ) {
    super(message)
    this.name = 'BotRuntimeError'
  }
}

function agentHostConfig(): { baseUrl: string; apiToken: string } | null {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/+$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

function runtimeConfigurationError(error: unknown): BotRuntimeError {
  const code = error instanceof Error ? error.message : ''
  if (code === 'PROVIDER_CREDENTIAL_REKEY_REQUIRED') {
    return new BotRuntimeError(code, code, 409, false)
  }
  if (code === 'PROVIDER_API_KEY_REQUIRED' || code === 'MODEL_NOT_ENABLED' || code === 'UNKNOWN_PROVIDER_MODEL' || code === 'UNKNOWN_PROVIDER') {
    return new BotRuntimeError(code, code, 400, false)
  }
  return new BotRuntimeError('MODEL_CONFIGURATION_INVALID', 'MODEL_CONFIGURATION_INVALID', 400, false)
}

function safeUpstreamCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'BOT_RUNTIME_UNAVAILABLE'
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string' && /^[A-Z0-9_]{3,80}$/.test(error)) return error
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code
    if (/^[A-Z0-9_]{3,80}$/.test(code)) return code
  }
  return 'BOT_RUNTIME_UNAVAILABLE'
}

/**
 * Materialise the Bot's Pi worker and its Project VM/OpenSandbox session.
 *
 * The Agent Host lease is deliberately the same contract Code mode uses. It
 * creates the session Worker, prepares the per-session OpenSandbox and warms
 * the session desktop. The Bot page never talks to the Agent Host directly;
 * this server-side adapter keeps the service token and provider credentials in
 * the BFF trust boundary.
 */
export async function warmBotRuntime(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<{ ready: true; agent: 'pi' }> {
  if (!bot.runtimeSessionId) {
    throw new BotRuntimeError('BOT_RUNTIME_NOT_READY', 'BOT_RUNTIME_NOT_READY', 409, false)
  }
  if (!bot.projectId) {
    throw new BotRuntimeError('BOT_PROJECT_NOT_READY', 'BOT_PROJECT_NOT_READY', 409, false)
  }
  if (!bot.providerId || !bot.modelId) {
    throw new BotRuntimeError('BOT_MODEL_REQUIRED', 'BOT_MODEL_REQUIRED', 400, false)
  }
  const config = agentHostConfig()
  if (!config) {
    throw new BotRuntimeError('AGENT_HOST_NOT_CONFIGURED', 'AGENT_HOST_NOT_CONFIGURED', 503, true)
  }

  let runtimeConfiguration
  try {
    runtimeConfiguration = await resolveAgentProviderRuntimeConfiguration(supabase, userId, {
      providerId: bot.providerId,
      modelId: bot.modelId,
    })
  } catch (error) {
    throw runtimeConfigurationError(error)
  }
  if (!runtimeConfiguration) {
    throw new BotRuntimeError('MODEL_CONFIGURATION_REQUIRED', 'MODEL_CONFIGURATION_REQUIRED', 400, false)
  }

  let nativeSession
  try {
    nativeSession = await loadPiSessionSnapshot(supabase, userId, bot.runtimeSessionId)
  } catch {
    throw new BotRuntimeError('PI_SESSION_READ_FAILED', 'PI_SESSION_READ_FAILED', 500, true)
  }

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/v1/agent/sessions/${encodeURIComponent(bot.runtimeSessionId)}/lease`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        workspaceId: bot.workspaceId,
        projectId: bot.projectId,
        sessionId: bot.runtimeSessionId,
        runtimeConfiguration,
        agent: 'pi',
        accessMode: 'restricted',
        ...(nativeSession ? { nativeSession } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(AGENT_HOST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new BotRuntimeError(
      error instanceof Error ? error.message : 'BOT_RUNTIME_UNAVAILABLE',
      'BOT_RUNTIME_UNAVAILABLE',
      503,
      true,
    )
  }

  const payload = await response.json().catch(() => null) as { ok?: unknown; ready?: unknown; error?: unknown } | null
  if (!response.ok) {
    const code = safeUpstreamCode(payload)
    throw new BotRuntimeError(code, code, response.status, response.status === 409 || response.status >= 500)
  }
  if (payload?.ready !== true && payload?.ok !== true) {
    throw new BotRuntimeError('BOT_RUNTIME_UNAVAILABLE', 'BOT_RUNTIME_UNAVAILABLE', 502, true)
  }
  return { ready: true, agent: 'pi' }
}

/**
 * Release the Agent Host session that backs a Bot before its durable rows are
 * removed. Deletion is an application operation: an already-clean session or a
 * busy turn must not make the Bot undeletable.
 */
export async function releaseBotRuntime(bot: BotSummary): Promise<void> {
  if (!bot.runtimeSessionId) return
  const config = agentHostConfig()
  if (!config) return

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/v1/agent/sessions/${encodeURIComponent(bot.runtimeSessionId)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: bot.userId,
        workspaceId: bot.workspaceId,
        sessionId: bot.runtimeSessionId,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    console.error('[openlink-bots] runtime session release deferred', error)
    return
  }
  await response.body?.cancel().catch(() => undefined)
  if (response.ok || response.status === 404 || response.status === 409) return
  console.error(`[openlink-bots] runtime session release failed (${response.status})`)
}

