import { getAiProviderConfiguration } from '@/lib/ai-provider-configurations.server'
import { getAiProviderModels } from '@/lib/ai-provider-models.server'
import {
  loadSessionContextUsage,
  type SessionContextUsage,
} from '@/lib/chat-session-persistence.server'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export interface SessionContextResponse {
  usage: SessionContextUsage
  contextWindow: number | null
  modelId: string | null
  providerId: string | null
}

/** Resolve a model's context window from persisted model params, then catalog. */
async function resolveContextWindow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  providerId: string | null,
  modelId: string | null,
  fallback: number | null,
): Promise<number | null> {
  const contextWindow = Number.isFinite(fallback) && (fallback as number) > 0 ? (fallback as number) : null
  if (contextWindow) return contextWindow
  if (!providerId || !modelId) return null
  try {
    const configuration = await getAiProviderConfiguration(supabase, userId, providerId)
    const params = configuration?.modelParams?.[modelId]
    if (params && Number.isFinite(params.contextWindow) && params.contextWindow > 0) return params.contextWindow
    const catalog = await getAiProviderModels(providerId)
    const catalogModel = catalog.find((model) => model.id === modelId)
    if (catalogModel && catalogModel.contextWindow > 0) return catalogModel.contextWindow
  } catch {
    // Best-effort: any resolution failure just leaves the window unknown.
  }
  return null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'INVALID_SESSION' }, { status: 404 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })

  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })

  const usage = await loadSessionContextUsage(supabase, user.id, sessionId, session.agent ?? 'codex')
  const contextWindow = await resolveContextWindow(
    supabase,
    user.id,
    session.provider_id,
    usage.modelId ?? session.model_id,
    usage.contextWindow,
  )

  const payload: SessionContextResponse = {
    usage,
    contextWindow,
    modelId: usage.modelId ?? session.model_id,
    providerId: session.provider_id,
  }
  return Response.json(payload, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
