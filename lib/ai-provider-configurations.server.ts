import 'server-only'

import { getAiProvider, isAiProviderId } from '@/lib/ai-providers'
import { getAiProviderModels } from '@/lib/ai-provider-models.server'
import { modelLogoSlug } from '@/lib/model-logos'
import type { AgentProviderRuntimeConfiguration, AiProviderConfigurationSummary, ConfiguredModelOption } from '@/lib/ai-provider-types'
import { decryptProviderSecret, encryptProviderSecret, providerSecretHint } from '@/lib/provider-secrets.server'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

interface ProviderConfigurationRow {
  user_id: string
  provider_id: string
  enabled: boolean
  is_default: boolean
  base_url: string | null
  default_model_id: string | null
  enabled_model_ids: string[]
  encrypted_api_key: string | null
  api_key_iv: string | null
  api_key_tag: string | null
  api_key_hint: string | null
  encryption_version: number
  created_at: string
  updated_at: string
}

export type { AgentProviderRuntimeConfiguration, AiProviderConfigurationSummary, ConfiguredModelOption } from '@/lib/ai-provider-types'

const selectColumns = 'user_id, provider_id, enabled, is_default, base_url, default_model_id, enabled_model_ids, encrypted_api_key, api_key_iv, api_key_tag, api_key_hint, encryption_version, created_at, updated_at'

function summary(row: ProviderConfigurationRow): AiProviderConfigurationSummary {
  return {
    providerId: row.provider_id,
    enabled: row.enabled,
    isDefault: row.is_default,
    baseUrl: row.base_url,
    defaultModelId: row.default_model_id,
    enabledModelIds: row.enabled_model_ids ?? [],
    apiKeyHint: row.api_key_hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listAiProviderConfigurations(supabase: ServerSupabaseClient, userId: string) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('ai_provider_configurations')
    .select(selectColumns)
    .eq('user_id', userId)
    .order('is_default', { ascending: false })
    .order('updated_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as ProviderConfigurationRow[]).map(summary)
}

export async function getAiProviderConfiguration(
  supabase: ServerSupabaseClient,
  userId: string,
  providerId: string,
) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('ai_provider_configurations')
    .select(selectColumns)
    .eq('user_id', userId)
    .eq('provider_id', providerId)
    .maybeSingle()
  if (error) throw error
  return data ? summary(data as ProviderConfigurationRow) : null
}

export interface SaveAiProviderConfigurationInput {
  providerId: string
  enabled: boolean
  isDefault: boolean
  baseUrl: string | null
  defaultModelId: string
  enabledModelIds: string[]
  apiKey?: string
  clearApiKey?: boolean
}

export async function saveAiProviderConfiguration(
  supabase: ServerSupabaseClient,
  userId: string,
  input: SaveAiProviderConfigurationInput,
) {
  const definition = getAiProvider(input.providerId)
  if (!definition) throw new Error('UNKNOWN_PROVIDER')
  const models = await getAiProviderModels(input.providerId)
  const modelIds = new Set(models.map((model) => model.id))
  const validDynamicModel = (modelId: string) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(modelId)
  if (models.length ? !modelIds.has(input.defaultModelId) : !validDynamicModel(input.defaultModelId)) throw new Error('UNKNOWN_PROVIDER_MODEL')
  if (input.enabledModelIds.some((modelId) => models.length ? !modelIds.has(modelId) : !validDynamicModel(modelId))) throw new Error('UNKNOWN_PROVIDER_MODEL')

  const existing = await getProviderRow(supabase, userId, input.providerId)
  const catalogBaseUrl = models.find((model) => model.baseUrl && !model.baseUrl.includes('{'))?.baseUrl
  const effectiveBaseUrl = input.baseUrl || definition.baseUrl || catalogBaseUrl || null
  if (input.enabled && !effectiveBaseUrl) throw new Error('PROVIDER_BASE_URL_REQUIRED')
  const payload: Record<string, unknown> = {
    user_id: userId,
    provider_id: input.providerId,
    enabled: input.enabled,
    is_default: input.enabled && input.isDefault,
    base_url: effectiveBaseUrl,
    default_model_id: input.defaultModelId,
    enabled_model_ids: [...new Set([input.defaultModelId, ...input.enabledModelIds])],
    updated_at: new Date().toISOString(),
  }

  if (input.apiKey) {
    const encrypted = encryptProviderSecret(input.apiKey, userId, input.providerId)
    Object.assign(payload, {
      encrypted_api_key: encrypted.ciphertext,
      api_key_iv: encrypted.iv,
      api_key_tag: encrypted.tag,
      api_key_hint: providerSecretHint(input.apiKey),
      encryption_version: encrypted.version,
    })
  } else if (input.clearApiKey) {
    Object.assign(payload, {
      encrypted_api_key: null,
      api_key_iv: null,
      api_key_tag: null,
      api_key_hint: null,
    })
  } else if (!existing?.encrypted_api_key && definition.authMode === 'api-key' && input.enabled) {
    throw new Error('PROVIDER_API_KEY_REQUIRED')
  }

  if (payload.is_default) {
    const { error: clearDefaultError } = await supabase
      .schema('openlink')
      .from('ai_provider_configurations')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .neq('provider_id', input.providerId)
    if (clearDefaultError) throw clearDefaultError
  }

  const { data, error } = await supabase
    .schema('openlink')
    .from('ai_provider_configurations')
    .upsert(payload, { onConflict: 'user_id,provider_id' })
    .select(selectColumns)
    .single()
  if (error) throw error
  return summary(data as ProviderConfigurationRow)
}

async function getProviderRow(supabase: ServerSupabaseClient, userId: string, providerId: string) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('ai_provider_configurations')
    .select(selectColumns)
    .eq('user_id', userId)
    .eq('provider_id', providerId)
    .maybeSingle()
  if (error) throw error
  return data as ProviderConfigurationRow | null
}

export async function resolveAgentProviderRuntimeConfiguration(
  supabase: ServerSupabaseClient,
  userId: string,
  requestedModel?: { providerId: string; modelId: string } | null,
): Promise<AgentProviderRuntimeConfiguration | null> {
  if (requestedModel && !isAiProviderId(requestedModel.providerId)) throw new Error('UNKNOWN_PROVIDER')
  let query = supabase
    .schema('openlink')
    .from('ai_provider_configurations')
    .select(selectColumns)
    .eq('user_id', userId)
    .eq('enabled', true)
  if (requestedModel) query = query.eq('provider_id', requestedModel.providerId)
  const { data, error } = await query
    .order('is_default', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  const row = data as ProviderConfigurationRow | null
  if (!row) return null
  const definition = getAiProvider(row.provider_id)
  if (!definition) throw new Error('UNKNOWN_PROVIDER')
  const modelId = requestedModel?.modelId ?? row.default_model_id
  if (!modelId || !row.enabled_model_ids.includes(modelId)) throw new Error('MODEL_NOT_ENABLED')
  const models = await getAiProviderModels(row.provider_id)
  if (models.length && !models.some((model) => model.id === modelId)) throw new Error('UNKNOWN_PROVIDER_MODEL')
  const modelBaseUrl = models.find((model) => model.id === modelId)?.baseUrl
  const baseUrl = row.base_url || modelBaseUrl || definition.baseUrl || ''
  if (!row.encrypted_api_key || !row.api_key_iv || !row.api_key_tag) {
    if (definition.authMode === 'ambient') {
      return {
        providerId: row.provider_id,
        modelId,
        apiKey: '',
        baseUrl,
        revision: row.updated_at,
      }
    }
    throw new Error('PROVIDER_API_KEY_REQUIRED')
  }
  let apiKey: string
  try {
    apiKey = decryptProviderSecret({
      ciphertext: row.encrypted_api_key,
      iv: row.api_key_iv,
      tag: row.api_key_tag,
      version: row.encryption_version as 1,
    }, userId, row.provider_id)
  } catch (error) {
    if (error instanceof Error && /authenticate data|bad decrypt|unable to authenticate/i.test(error.message)) {
      throw new Error('PROVIDER_CREDENTIAL_REKEY_REQUIRED')
    }
    throw error
  }
  return {
    providerId: row.provider_id,
    modelId,
    apiKey,
    baseUrl,
    revision: row.updated_at,
  }
}

export async function resolveConfiguredModelSelection(
  supabase: ServerSupabaseClient,
  userId: string,
  requestedModel?: { providerId: string; modelId: string } | null,
): Promise<{ providerId: string; modelId: string } | null> {
  if (requestedModel && !isAiProviderId(requestedModel.providerId)) throw new Error('UNKNOWN_PROVIDER')
  if (requestedModel && (!requestedModel.modelId || requestedModel.modelId.length > 256)) throw new Error('INVALID_MODEL')

  let query = supabase
    .schema('openlink')
    .from('ai_provider_configurations')
    .select('provider_id, default_model_id, enabled_model_ids')
    .eq('user_id', userId)
    .eq('enabled', true)
  if (requestedModel) query = query.eq('provider_id', requestedModel.providerId)

  const { data, error } = await query
    .order('is_default', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  const row = data as { provider_id: string; default_model_id: string | null; enabled_model_ids: string[] } | null
  if (!row) return null

  const modelId = requestedModel?.modelId ?? row.default_model_id
  if (!modelId || !row.enabled_model_ids.includes(modelId)) throw new Error('MODEL_NOT_ENABLED')
  const models = await getAiProviderModels(row.provider_id)
  if (models.length && !models.some((model) => model.id === modelId)) throw new Error('UNKNOWN_PROVIDER_MODEL')
  return { providerId: row.provider_id, modelId }
}

export async function listConfiguredModels(supabase: ServerSupabaseClient, userId: string): Promise<ConfiguredModelOption[]> {
  const configurations = await listAiProviderConfigurations(supabase, userId)
  const enabled = configurations.filter((configuration) => configuration.enabled)
  const groups = await Promise.all(enabled.map(async (configuration) => {
    const definition = getAiProvider(configuration.providerId)
    const models = await getAiProviderModels(configuration.providerId)
    const enabledIds = new Set(configuration.enabledModelIds)
    const availableModels = models.length
      ? models
      : configuration.enabledModelIds.map((id) => ({ id, name: id }))
    return availableModels
      .filter((model) => enabledIds.has(model.id))
      .map((model) => ({
        id: `${configuration.providerId}/${model.id}`,
        providerId: configuration.providerId,
        providerName: definition?.name ?? configuration.providerId,
        modelId: model.id,
        name: model.name,
        // Model logos are matched by model name so the composer shows the
        // model's own brand (e.g. a deepseek model keeps the DeepSeek mark)
        // instead of the provider logo. Fall back to the provider slug.
        logo: modelLogoSlug(model.name) ?? definition?.logo ?? configuration.providerId,
        isDefault: configuration.isDefault && configuration.defaultModelId === model.id,
      }))
  }))
  return groups.flat().sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name))
}
