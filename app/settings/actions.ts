'use server'

import {
  getAiProviderConfiguration,
  resolveAgentProviderRuntimeConfiguration,
  saveAiProviderConfiguration,
} from '@/lib/ai-provider-configurations.server'
import { getAiProvider } from '@/lib/ai-providers'
import { ensureDraftProject } from '@/lib/projects'
import { getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

const preferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  locale: z.enum(['zh-CN', 'en-US']),
  chatPosition: z.enum(['left', 'right']),
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
        custom_instructions: parsed.data.customInstructions,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    if (error) throw error
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
      apiKey: parsed.data.apiKey || undefined,
    })
    revalidatePath('/settings/ai-providers')
    revalidatePath(`/settings/ai-providers/${configuration.providerId}`)
    return { ok: true as const, configuration }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'PROVIDER_SAVE_FAILED' }
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
