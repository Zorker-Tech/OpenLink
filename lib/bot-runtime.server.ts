import 'server-only'

import { resolveAgentProviderRuntimeConfiguration } from '@/lib/ai-provider-configurations.server'
import type { BotSummary } from '@/lib/bot-types'
import {
  ensureBotBox,
  releaseBotBox,
  respondBotExtensionUi,
  sendBotPromptStream,
} from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

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

/**
 * Work-host owns the Bot turn and its sandbox. This adapter keeps the
 * application's error vocabulary stable while the Work-host error keeps its
 * retryability: a 409 is a lifecycle conflict, a 5xx is retryable, and a 4xx
 * is a request the caller must correct.
 */
function workHostRuntimeError(error: unknown): BotRuntimeError {
  if (error instanceof BotRuntimeError) return error
  const status = error !== null && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : 503
  // The Work-host token is a server credential. A 401/403 from it is a
  // deployment misconfiguration, not the browser user's authentication
  // failure; never forward it as a session-level auth error.
  if (status === 401 || status === 403) {
    return new BotRuntimeError('BOT_RUNTIME_UNAVAILABLE', 'BOT_RUNTIME_UNAVAILABLE', 503, true)
  }
  const code = status === 409
    ? 'BOT_RUNTIME_BUSY'
    : status === 400
      ? 'BOT_RUNTIME_INVALID'
      : status === 503
        ? 'BOT_SUBSTRATE_UNAVAILABLE'
        : 'BOT_RUNTIME_UNAVAILABLE'
  return new BotRuntimeError(code, code, status >= 400 && status < 600 ? status : 503, status >= 500 || status === 409)
}

/**
 * Materialise the Bot's one OpenSandbox inside the Project VM and return its
 * desktop. Work-host owns the binding; the BFF never sees the worker
 * credentials and never addresses a Code chat session.
 */
export async function warmBotRuntime(
  supabase: ServerSupabaseClient,
  userId: string,
  bot: BotSummary,
): Promise<{ ready: true; agent: 'pi'; desktopUrl: string }> {
  if (!bot.runtimeKey) {
    throw new BotRuntimeError('BOT_RUNTIME_NOT_READY', 'BOT_RUNTIME_NOT_READY', 409, false)
  }
  if (!bot.projectId) {
    throw new BotRuntimeError('BOT_PROJECT_NOT_READY', 'BOT_PROJECT_NOT_READY', 409, false)
  }
  if (!bot.providerId || !bot.modelId) {
    throw new BotRuntimeError('BOT_MODEL_REQUIRED', 'BOT_MODEL_REQUIRED', 400, false)
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

  try {
    const box = await ensureBotBox({
      agentId: bot.workAgentId,
      botId: bot.id,
      projectId: bot.projectId,
      userId,
      workspaceId: bot.workspaceId,
      runtimeConfiguration,
    })
    return { ready: true, agent: 'pi', desktopUrl: box.desktopUrl }
  } catch (error) {
    throw workHostRuntimeError(error)
  }
}

/**
 * Release the Bot's sandbox and its Work-host binding. Deletion is an
 * application operation: an already-released sandbox or a temporarily
 * unreachable substrate must not make the Bot undeletable.
 */
export async function releaseBotRuntime(bot: BotSummary): Promise<void> {
  try {
    await releaseBotBox(bot.workAgentId)
  } catch (error) {
    console.error('[openlink-bots] Bot sandbox release deferred', error)
  }
}

export async function respondBotConfirmation(
  bot: BotSummary,
  input: { id: string; approved?: boolean; value?: string },
): Promise<void> {
  const response = input.approved === true
    ? { confirmed: true as const }
    : input.approved === false
      ? { cancelled: true as const }
      : { value: input.value ?? '' }
  try {
    await respondBotExtensionUi({
      agentId: bot.workAgentId,
      id: input.id,
      ...response,
    })
  } catch (error) {
    throw workHostRuntimeError(error)
  }
}

/**
 * Accept the turn in Work-host and return its frame stream. The durable
 * acceptance happens before this returns; a later disconnect only stops the
 * projection.
 */
export async function streamBotPrompt(
  bot: BotSummary,
  message: string,
  clientNonce?: string,
): Promise<Response> {
  try {
    return await sendBotPromptStream({
      agentId: bot.workAgentId,
      prompt: message,
      ...(clientNonce === undefined ? {} : { clientNonce }),
    })
  } catch (error) {
    throw workHostRuntimeError(error)
  }
}
