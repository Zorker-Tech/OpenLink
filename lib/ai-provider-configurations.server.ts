import 'server-only'

import { getAiProvider, isAiProviderId } from '@/lib/ai-providers'
import { getAiProviderModels } from '@/lib/ai-provider-models.server'
import { modelLogoSlug } from '@/lib/model-logos'
import type { AgentProviderRuntimeConfiguration, AiProviderConfigurationSummary, AiProviderModel, ConfiguredModelOption, ProviderModelParams } from '@/lib/ai-provider-types'
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
  model_params: Record<string, ProviderModelParams> | null
  encrypted_api_key: string | null
  api_key_iv: string | null
  api_key_tag: string | null
  api_key_hint: string | null
  encryption_version: number
  created_at: string
  updated_at: string
}

export type { AgentProviderRuntimeConfiguration, AiProviderConfigurationSummary, ConfiguredModelOption, ProviderModelParams } from '@/lib/ai-provider-types'

const selectColumns = 'user_id, provider_id, enabled, is_default, base_url, default_model_id, enabled_model_ids, model_params, encrypted_api_key, api_key_iv, api_key_tag, api_key_hint, encryption_version, created_at, updated_at'

function summary(row: ProviderConfigurationRow): AiProviderConfigurationSummary {
  return {
    providerId: row.provider_id,
    enabled: row.enabled,
    isDefault: row.is_default,
    baseUrl: row.base_url,
    defaultModelId: row.default_model_id,
    enabledModelIds: row.enabled_model_ids ?? [],
    modelParams: row.model_params ?? {},
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
  modelParams?: Record<string, ProviderModelParams>
  apiKey?: string
  clearApiKey?: boolean
}

function defaultModelParams(modelId: string): ProviderModelParams {
  return {
    name: modelId,
    reasoning: false,
    input: ['text'],
    // Conservative, editable defaults for models without catalog metadata.
    // The settings UI exposes every field so users can correct them.
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0 },
  }
}

/**
 * Merge stored model params with the incoming edit. Every enabled model must
 * end up with a params entry so consumers (context-window resolution, the
 * model editor) never see a parameterless model: entries survive from the
 * incoming payload, then stored values, then documented defaults.
 */
function mergeModelParams(
  incoming: Record<string, ProviderModelParams> | undefined,
  stored: Record<string, ProviderModelParams> | null | undefined,
  catalog: AiProviderModel[],
  enabledModelIds: string[],
): Record<string, ProviderModelParams> {
  const merged: Record<string, ProviderModelParams> = {}
  for (const model of catalog) {
    merged[model.id] = {
      name: model.name,
      reasoning: Boolean(model.reasoning),
      input: Array.isArray(model.input) && model.input.length ? model.input : ['text'],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
    }
  }
  for (const [modelId, params] of Object.entries(stored ?? {})) {
    if (params) merged[modelId] = params
  }
  for (const [modelId, params] of Object.entries(incoming ?? {})) {
    if (params) merged[modelId] = params
  }
  for (const modelId of enabledModelIds) {
    if (!merged[modelId]) merged[modelId] = defaultModelParams(modelId)
  }
  return merged
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
  if (input.modelParams !== undefined) {
    for (const [modelId, params] of Object.entries(input.modelParams)) {
      if (!validDynamicModel(modelId)) throw new Error('UNKNOWN_PROVIDER_MODEL')
      if (!params) continue
      if (!Number.isFinite(params.contextWindow) || !Number.isFinite(params.maxTokens)) throw new Error('MODEL_PARAMS_INVALID')
    }
  }

  const existing = await getProviderRow(supabase, userId, input.providerId)
  const catalogBaseUrl = models.find((model) => model.baseUrl && !model.baseUrl.includes('{'))?.baseUrl
  const effectiveBaseUrl = input.baseUrl || definition.baseUrl || catalogBaseUrl || null
  if (input.enabled && !effectiveBaseUrl) throw new Error('PROVIDER_BASE_URL_REQUIRED')
  const enabledModelIds = [...new Set([input.defaultModelId, ...input.enabledModelIds])]
  const payload: Record<string, unknown> = {
    user_id: userId,
    provider_id: input.providerId,
    enabled: input.enabled,
    is_default: input.enabled && input.isDefault,
    base_url: effectiveBaseUrl,
    default_model_id: input.defaultModelId,
    enabled_model_ids: enabledModelIds,
    model_params: mergeModelParams(input.modelParams, existing?.model_params, models, enabledModelIds),
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

/** Return the decrypted stored API key for a provider, or null when absent. */
export async function getStoredProviderApiKey(
  supabase: ServerSupabaseClient,
  userId: string,
  providerId: string,
): Promise<string | null> {
  const row = await getProviderRow(supabase, userId, providerId)
  if (!row?.encrypted_api_key || !row.api_key_iv || !row.api_key_tag) return null
  try {
    return decryptProviderSecret({
      ciphertext: row.encrypted_api_key,
      iv: row.api_key_iv,
      tag: row.api_key_tag,
      version: row.encryption_version as 1,
    }, userId, providerId)
  } catch {
    return null
  }
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
  const modelDefinition = models.find((model) => model.id === modelId)
  if (models.length && !modelDefinition) throw new Error('UNKNOWN_PROVIDER_MODEL')
  const modelBaseUrl = modelDefinition?.baseUrl
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
    const catalog = await getAiProviderModels(configuration.providerId)
    const enabledIds = new Set(configuration.enabledModelIds)
    const storedParams = configuration.modelParams ?? {}

    // Build the merged set of model ids: catalog ids plus any hand-added /
    // fetched ids present in model params. Persisted params override catalog
    // metadata so edits survive reloads.
    const catalogById = new Map(catalog.map((model) => [model.id, model]))
    const knownIds = new Set<string>([...catalogById.keys(), ...Object.keys(storedParams)])
    // A dynamic provider (no catalog) exposes exactly the enabled ids; carry
    // any enabled id that is not yet in knownIds so it still appears.
    if (!catalog.length) {
      for (const id of enabledIds) knownIds.add(id)
    }

    return [...knownIds]
      .filter((modelId) => enabledIds.has(modelId))
      .map((modelId) => {
        const catalogModel = catalogById.get(modelId)
        const overrides = storedParams[modelId]
        const name = overrides?.name || catalogModel?.name || modelId
        return {
          id: `${configuration.providerId}/${modelId}`,
          providerId: configuration.providerId,
          providerName: definition?.name ?? configuration.providerId,
          modelId,
          name,
          // Model logos are matched by model name so the composer shows the
          // model's own brand (e.g. a deepseek model keeps the DeepSeek mark)
          // instead of the provider logo. Fall back to the provider slug.
          logo: modelLogoSlug(name) ?? definition?.logo ?? configuration.providerId,
          isDefault: configuration.isDefault && configuration.defaultModelId === modelId,
        }
      })
  }))
  return groups.flat().sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name))
}
