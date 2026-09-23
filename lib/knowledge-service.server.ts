import 'server-only'

import { createClient } from '@/utils/supabase/server'
import { getT } from '@/lib/i18n/server'
import { resolveEmbeddingProviderRuntimeConfiguration } from '@/lib/embedding-provider-configurations.server'

export type KnowledgeServiceConfig = { baseUrl: string; token: string }

export function knowledgeServiceConfig(): KnowledgeServiceConfig | null {
  if (process.env.OPENLINK_KNOWLEDGE_ENABLED === '0') return null
  const baseUrl = process.env.OPENLINK_KNOWLEDGE_SERVICE_URL?.trim().replace(/\/$/, '')
  const token = process.env.OPENLINK_KNOWLEDGE_INTERNAL_TOKEN?.trim()
  return baseUrl && token ? { baseUrl, token } : null
}

export async function authenticatedKnowledgeRequest(
  request: Request,
  input: { workspaceId?: string; body?: Record<string, unknown>; path: string; method?: string },
) {
  const config = knowledgeServiceConfig()
  if (!config) {
    const coreProfile = process.env.OPENLINK_DEPLOYMENT_PROFILE === 'core' || process.env.OPENLINK_KNOWLEDGE_ENABLED === '0'
    const { t } = await getT()
    return {
      response: Response.json({
        error: coreProfile
          ? { code: "FEATURE_NOT_AVAILABLE_IN_CORE", message: t("内置知识库在 Core 部署模式中未启用。切换到 Standard 或 Dense 后可使用。"), retryable: false }
          : { code: 'KNOWLEDGE_SERVICE_NOT_CONFIGURED', retryable: true },
      }, { status: coreProfile ? 409 : 503 }),
    }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { response: Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }) }
  const workspaceId = input.workspaceId || input.body?.workspaceId
  const embedding = await resolveEmbeddingProviderRuntimeConfiguration(supabase, user.id)
  const body = { ...(input.body || {}), userId: user.id, ...(workspaceId ? { workspaceId } : {}), ...(embedding ? { embedding } : {}) }
  let upstream: Response
  try {
    const upstreamUrl = new URL(`${config.baseUrl}${input.path}`)
    if (!input.method || input.method === 'GET') {
      upstreamUrl.searchParams.set('userId', user.id)
      if (workspaceId) upstreamUrl.searchParams.set('workspaceId', String(workspaceId))
    }
    upstream = await fetch(upstreamUrl, {
      method: input.method || 'GET',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', ...(embedding ? { 'X-OpenLink-Embedding': Buffer.from(JSON.stringify(embedding)).toString('base64url') } : {}) },
      ...(input.method && input.method !== 'GET' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    })
  } catch {
    return { response: Response.json({ error: { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE', retryable: true } }, { status: 503 }) }
  }
  return { response: new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) }
}
