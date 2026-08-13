import 'server-only'

import { getEmbeddingProvider, isEmbeddingProviderId, type EmbeddingProtocol } from '@/lib/embedding-providers'
import type { EmbeddingProviderConfigurationSummary, EmbeddingProviderRuntimeConfiguration } from '@/lib/ai-provider-types'
import { decryptProviderSecret, encryptProviderSecret, providerSecretHint } from '@/lib/provider-secrets.server'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

interface Row {
  user_id: string
  provider_id: string
  enabled: boolean
  is_default: boolean
  base_url: string | null
  protocol: EmbeddingProtocol
  default_model_id: string
  vector_dimension: number
  encrypted_api_key: string | null
  api_key_iv: string | null
  api_key_tag: string | null
  api_key_hint: string | null
  encryption_version: number
  created_at: string
  updated_at: string
}

const columns = 'user_id,provider_id,enabled,is_default,base_url,protocol,default_model_id,vector_dimension,encrypted_api_key,api_key_iv,api_key_tag,api_key_hint,encryption_version,created_at,updated_at'

function summary(row: Row): EmbeddingProviderConfigurationSummary {
  return {
    providerId: row.provider_id, enabled: row.enabled, isDefault: row.is_default, baseUrl: row.base_url,
    protocol: row.protocol, defaultModelId: row.default_model_id, vectorDimension: row.vector_dimension,
    apiKeyHint: row.api_key_hint, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function validModelId(value: string) { return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) }

export interface SaveEmbeddingProviderConfigurationInput {
  providerId: string
  enabled: boolean
  isDefault: boolean
  baseUrl: string | null
  protocol: EmbeddingProtocol
  defaultModelId: string
  vectorDimension: number
  apiKey?: string
  clearApiKey?: boolean
}

export async function listEmbeddingProviderConfigurations(supabase: ServerSupabaseClient, userId: string) {
  const { data, error } = await supabase.schema('openlink').from('embedding_provider_configurations').select(columns).eq('user_id', userId).order('is_default', { ascending: false }).order('updated_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as Row[]).map(summary)
}

export async function getEmbeddingProviderConfiguration(supabase: ServerSupabaseClient, userId: string, providerId: string) {
  const { data, error } = await supabase.schema('openlink').from('embedding_provider_configurations').select(columns).eq('user_id', userId).eq('provider_id', providerId).maybeSingle()
  if (error) throw error
  return data ? summary(data as Row) : null
}

export async function saveEmbeddingProviderConfiguration(supabase: ServerSupabaseClient, userId: string, input: SaveEmbeddingProviderConfigurationInput) {
  const definition = getEmbeddingProvider(input.providerId)
  if (!definition || !validModelId(input.defaultModelId) || !Number.isSafeInteger(input.vectorDimension) || input.vectorDimension < 2 || input.vectorDimension > 32_768) throw new Error('INVALID_EMBEDDING_CONFIGURATION')
  if (input.protocol !== definition.protocol) throw new Error('INVALID_EMBEDDING_PROTOCOL')
  const baseUrl = input.baseUrl || definition.baseUrl || null
  if (!baseUrl) throw new Error('PROVIDER_BASE_URL_REQUIRED')
  const existing = await getEmbeddingRow(supabase, userId, input.providerId)
  const payload: Record<string, unknown> = {
    user_id: userId, provider_id: input.providerId, enabled: input.enabled, is_default: input.enabled && input.isDefault,
    base_url: baseUrl, protocol: input.protocol, default_model_id: input.defaultModelId, vector_dimension: input.vectorDimension, updated_at: new Date().toISOString(),
  }
  if (input.apiKey) {
    const encrypted = encryptProviderSecret(input.apiKey, userId, `embedding/${input.providerId}`)
    Object.assign(payload, { encrypted_api_key: encrypted.ciphertext, api_key_iv: encrypted.iv, api_key_tag: encrypted.tag, api_key_hint: providerSecretHint(input.apiKey), encryption_version: encrypted.version })
  } else if (input.clearApiKey) {
    Object.assign(payload, { encrypted_api_key: null, api_key_iv: null, api_key_tag: null, api_key_hint: null })
  } else if (input.enabled && definition.apiKeyRequired && !existing?.encrypted_api_key) throw new Error('PROVIDER_API_KEY_REQUIRED')
  if (payload.is_default) {
    const { error } = await supabase.schema('openlink').from('embedding_provider_configurations').update({ is_default: false, updated_at: new Date().toISOString() }).eq('user_id', userId).neq('provider_id', input.providerId)
    if (error) throw error
  }
  const { data, error } = await supabase.schema('openlink').from('embedding_provider_configurations').upsert(payload, { onConflict: 'user_id,provider_id' }).select(columns).single()
  if (error) throw error
  return summary(data as Row)
}

async function getEmbeddingRow(supabase: ServerSupabaseClient, userId: string, providerId: string) {
  const { data, error } = await supabase.schema('openlink').from('embedding_provider_configurations').select(columns).eq('user_id', userId).eq('provider_id', providerId).maybeSingle()
  if (error) throw error
  return data as Row | null
}

/** Used by the trusted Knowledge Service route only; secret never reaches a client. */
export async function resolveEmbeddingProviderRuntimeConfiguration(supabase: ServerSupabaseClient, userId: string, providerId?: string): Promise<EmbeddingProviderRuntimeConfiguration | null> {
  if (providerId && !isEmbeddingProviderId(providerId)) throw new Error('UNKNOWN_EMBEDDING_PROVIDER')
  let query = supabase.schema('openlink').from('embedding_provider_configurations').select(columns).eq('user_id', userId).eq('enabled', true)
  if (providerId) query = query.eq('provider_id', providerId)
  const { data, error } = await query.order('is_default', { ascending: false }).order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw error
  const row = data as Row | null
  if (!row) return null
  const definition = getEmbeddingProvider(row.provider_id)
  if (!definition) throw new Error('UNKNOWN_EMBEDDING_PROVIDER')
  let apiKey = ''
  if (row.encrypted_api_key && row.api_key_iv && row.api_key_tag) {
    apiKey = decryptProviderSecret({ ciphertext: row.encrypted_api_key, iv: row.api_key_iv, tag: row.api_key_tag, version: row.encryption_version as 1 }, userId, `embedding/${row.provider_id}`)
  } else if (definition.apiKeyRequired) throw new Error('PROVIDER_API_KEY_REQUIRED')
  return { providerId: row.provider_id, modelId: row.default_model_id, baseUrl: row.base_url || definition.baseUrl, protocol: row.protocol, vectorDimension: row.vector_dimension, apiKey, revision: row.updated_at }
}
