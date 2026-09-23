'use server'

import {
  getAiProviderConfiguration,
  getStoredProviderApiKey,
  resolveAgentProviderRuntimeConfiguration,
  saveAiProviderConfiguration,
} from '@/lib/ai-provider-configurations.server'
import { getAiProviderModels } from '@/lib/ai-provider-models.server'
import { getEmbeddingProvider } from '@/lib/embedding-providers'
import { saveEmbeddingProviderConfiguration } from '@/lib/embedding-provider-configurations.server'
import { getAiProvider } from '@/lib/ai-providers'
import { ensureDraftProject } from '@/lib/projects'
import { getOwnedWorkspace } from '@/lib/workspaces'
import type { AiProviderModel, ProviderModelParams } from '@/lib/ai-provider-types'
import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { LOCALES } from '@/lib/i18n/locales'
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/i18n/messages'

const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  locale: z.enum(LOCALES),
  chatPosition: z.enum(['left', 'right']),
  thinkingVisibility: z.enum(['summary', 'hidden']),
  customInstructions: z.string().max(12_000),
})

const providerSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  baseUrl: z.string().trim().max(2048).refine((value) => {
    if (!value) return true
    try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
  }, 'INVALID_BASE_URL'),
  defaultModelId: z.string().min(1).max(256),
  enabledModelIds: z.array(z.string().min(1).max(256)).max(256),
  modelParams: z.record(z.string().min(1).max(256), z.object({
    name: z.string().min(1).max(256),
    reasoning: z.boolean(),
    input: z.array(z.enum(['text', 'image'])).max(8),
    contextWindow: z.number().int().min(1).max(100_000_000),
    maxTokens: z.number().int().min(1).max(100_000_000),
    cost: z.object({
      input: z.number().min(0).max(1_000_000),
      output: z.number().min(0).max(1_000_000),
      cacheRead: z.number().min(0).max(1_000_000).optional(),
      cacheWrite: z.number().min(0).max(1_000_000).optional(),
    }),
  })).optional(),
  apiKey: z.string().trim().max(8192).optional(),
  clearApiKey: z.boolean().optional(),
})

const fetchModelsSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  baseUrl: z.string().trim().max(2048).refine((value) => {
    if (!value) return false
    try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
  }, 'INVALID_BASE_URL'),
  apiKey: z.string().trim().max(8192).optional(),
})

const embeddingProviderSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  baseUrl: providerSchema.shape.baseUrl,
  protocol: z.enum(['openai', 'ollama', 'tei']),
  defaultModelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  vectorDimension: z.number().int().min(2).max(32_768),
  apiKey: z.string().trim().max(8192).optional(),
  clearApiKey: z.boolean().optional(),
})

async function authenticatedClient() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('AUTH_REQUIRED')
  return { supabase, user }
}

export async function saveUserPreferencesAction(input: unknown) {
  const parsed = preferencesSchema.safeParse(input)
  if (!parsed.success) return { ok: false as const, error: 'INVALID_PREFERENCES' }
  try {
    const { supabase, user } = await authenticatedClient()
    const { error } = await supabase
      .schema('openlink')
      .from('user_preferences')
      .upsert({
        user_id: user.id,
        theme: parsed.data.theme,
        locale: parsed.data.locale,
        chat_position: parsed.data.chatPosition,
        thinking_visibility: parsed.data.thinkingVisibility,
        custom_instructions: parsed.data.customInstructions,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    if (error) throw error
    // Mirror the locale into a cookie so the next server render — and every
    // route after a client-side navigation — already knows the language.
    const cookieStore = await cookies()
    cookieStore.set(LOCALE_COOKIE, parsed.data.locale, {
      path: '/',
      sameSite: 'lax',
      maxAge: LOCALE_COOKIE_MAX_AGE,
    })
    revalidatePath('/settings')
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'PREFERENCES_SAVE_FAILED' }
  }
}

export async function saveAiProviderConfigurationAction(input: unknown) {
  const parsed = providerSchema.safeParse(input)
  if (!parsed.success || !getAiProvider(parsed.data?.providerId ?? '')) {
    return { ok: false as const, error: 'INVALID_PROVIDER_CONFIGURATION' }
  }
  try {
    const { supabase, user } = await authenticatedClient()
    const configuration = await saveAiProviderConfiguration(supabase, user.id, {
      ...parsed.data,
      baseUrl: parsed.data.baseUrl || null,
      modelParams: parsed.data.modelParams,
      apiKey: parsed.data.apiKey || undefined,
    })
    revalidatePath('/settings/ai-providers')
    revalidatePath(`/settings/ai-providers/${configuration.providerId}`)
    return { ok: true as const, configuration }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'PROVIDER_SAVE_FAILED' }
  }
}

export async function saveEmbeddingProviderConfigurationAction(input: unknown) {
  const parsed = embeddingProviderSchema.safeParse(input)
  if (!parsed.success || !getEmbeddingProvider(parsed.data?.providerId ?? '')) return { ok: false as const, error: 'INVALID_EMBEDDING_CONFIGURATION' }
  try {
    const { supabase, user } = await authenticatedClient()
    const configuration = await saveEmbeddingProviderConfiguration(supabase, user.id, {
      ...parsed.data,
      baseUrl: parsed.data.baseUrl || null,
      apiKey: parsed.data.apiKey || undefined,
    })
    revalidatePath('/settings/ai-providers')
    revalidatePath(`/settings/ai-providers/embeddings/${configuration.providerId}`)
    return { ok: true as const, configuration }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'EMBEDDING_PROVIDER_SAVE_FAILED' }
  }
}

export async function toggleAiProviderEnabledAction(providerId: string, enabled: boolean) {
  const parsed = z.object({
    providerId: providerSchema.shape.providerId,
    enabled: z.boolean(),
  }).safeParse({ providerId, enabled })
  if (!parsed.success || !getAiProvider(parsed.data?.providerId ?? '')) {
    return { ok: false as const, error: 'INVALID_PROVIDER_CONFIGURATION' }
  }

  try {
    const { supabase, user } = await authenticatedClient()
    const existing = await getAiProviderConfiguration(supabase, user.id, parsed.data.providerId)
    if (!existing?.defaultModelId) {
      return { ok: false as const, error: 'PROVIDER_CONFIGURATION_REQUIRED' }
    }

    const configuration = await saveAiProviderConfiguration(supabase, user.id, {
      providerId: parsed.data.providerId,
      enabled: parsed.data.enabled,
      isDefault: parsed.data.enabled && existing.isDefault,
      baseUrl: existing.baseUrl,
      defaultModelId: existing.defaultModelId,
      enabledModelIds: existing.enabledModelIds,
    })
    revalidatePath('/settings/ai-providers')
    revalidatePath(`/settings/ai-providers/${configuration.providerId}`)
    return { ok: true as const, configuration }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'PROVIDER_TOGGLE_FAILED' }
  }
}

export async function checkAiProviderConfigurationAction(providerId: string, modelId: string) {
  const parsed = z.object({ providerId: providerSchema.shape.providerId, modelId: z.string().min(1).max(256) }).safeParse({ providerId, modelId })
  if (!parsed.success) return { ok: false as const, error: 'INVALID_PROVIDER_CONFIGURATION' }
  try {
    const { supabase, user } = await authenticatedClient()
    const runtimeConfiguration = await resolveAgentProviderRuntimeConfiguration(supabase, user.id, parsed.data)
    if (!runtimeConfiguration) return { ok: false as const, error: 'PROVIDER_NOT_ENABLED' }
    // Provider checks are real agent workloads too. Route them through the
    // user's durable Draft project so they provision inside that project's VM
    // instead of falling back to the old process-global OpenSandbox.
    const workspace = await getOwnedWorkspace(supabase, user.id)
    if (!workspace) return { ok: false as const, error: 'CHAT_WORKSPACE_NOT_FOUND' }
    const draft = await ensureDraftProject(supabase, user.id, workspace)
    const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
    const token = process.env.OPENLINK_AGENT_API_TOKEN
    if (!baseUrl || !token) return { ok: false as const, error: 'AGENT_HOST_NOT_CONFIGURED' }
    const response = await fetch(`${baseUrl}/v1/providers/check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        workspaceId: 'provider-settings',
        projectId: draft.id,
        runtimeConfiguration,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false as const, error: detail.slice(0, 500) || 'PROVIDER_CHECK_FAILED' }
    }
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'PROVIDER_CHECK_FAILED' }
  }
}

function defaultModelParams(modelId: string): ProviderModelParams {
  return {
    name: modelId,
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0 },
  }
}

function toProviderModelParams(modelId: string, catalog?: AiProviderModel): ProviderModelParams {
  if (!catalog) return defaultModelParams(modelId)
  return {
    name: catalog.name,
    reasoning: catalog.reasoning,
    input: Array.isArray(catalog.input) && catalog.input.length ? catalog.input : ['text'],
    contextWindow: catalog.contextWindow,
    maxTokens: catalog.maxTokens,
    cost: catalog.cost,
  }
}

export type FetchProviderModelsResult =
  | { ok: true; models: Array<ProviderModelParams & { id: string }>; error: null }
  | { ok: false; models: null; error: string }

/**
 * Fetch the model list from an OpenAI-compatible upstream `/models` endpoint
 * using the given (or stored) API key, enriching each model id with Pi catalog
 * metadata when available so the UI can show and edit full parameters.
 */
export async function fetchProviderModelsAction(input: unknown): Promise<FetchProviderModelsResult> {
  const parsed = fetchModelsSchema.safeParse(input)
  if (!parsed.success || !getAiProvider(parsed.data.providerId)) {
    return { ok: false, models: null, error: 'INVALID_PROVIDER_CONFIGURATION' }
  }
  try {
    const { supabase, user } = await authenticatedClient()
    const apiKey = (parsed.data.apiKey || '').trim() || await getStoredProviderApiKey(supabase, user.id, parsed.data.providerId)
    if (!apiKey) return { ok: false, models: null, error: 'PROVIDER_API_KEY_REQUIRED' }

    const baseUrl = parsed.data.baseUrl.replace(/\/+$/, '')
    const modelsUrl = `${baseUrl}/models`
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, models: null, error: `FETCH_MODELS_FAILED_${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
    }

    const payload = await response.json().catch(() => null) as { data?: unknown } | unknown[] | null
    const rawModels = Array.isArray(payload)
      ? payload
      : (payload as { data?: unknown } | null)?.data
    const ids: string[] = []
    const nameById = new Map<string, string>()
    if (Array.isArray(rawModels)) {
      for (const entry of rawModels) {
        if (!entry || typeof entry !== 'object') continue
        const item = entry as Record<string, unknown>
        if (typeof item.id !== 'string' || !item.id.trim()) continue
        ids.push(item.id.trim())
        if (typeof item.name === 'string' && item.name.trim()) nameById.set(item.id.trim(), item.name.trim())
      }
    }
    if (!ids.length) return { ok: false, models: null, error: 'FETCH_MODELS_EMPTY' }
    if (ids.length > 256) ids.length = 256

    const catalog = await getAiProviderModels(parsed.data.providerId)
    const catalogById = new Map(catalog.map((model) => [model.id, model]))
    const models = ids.map((modelId) => {
      const params = toProviderModelParams(modelId, catalogById.get(modelId))
      const upstreamName = nameById.get(modelId)
      if (upstreamName && upstreamName !== modelId) params.name = upstreamName
      return { id: modelId, ...params }
    })
    // Deterministic order: catalog order first, then upstream-only entries.
    return { ok: true, models, error: null }
  } catch (error) {
    return { ok: false, models: null, error: error instanceof Error ? error.message : 'FETCH_MODELS_FAILED' }
  }
}
