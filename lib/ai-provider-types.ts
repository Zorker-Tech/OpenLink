export interface AiProviderConfigurationSummary {
  providerId: string
  enabled: boolean
  isDefault: boolean
  baseUrl: string | null
  defaultModelId: string | null
  enabledModelIds: string[]
  modelParams?: Record<string, ProviderModelParams>
  apiKeyHint: string | null
  createdAt: string
  updatedAt: string
}

export interface AiProviderModel {
  id: string
  name: string
  api: string
  baseUrl: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

export interface ConfiguredModelOption {
  id: string
  providerId: string
  providerName: string
  modelId: string
  name: string
  logo: string
  isDefault: boolean
}

/** Editable per-model metadata stored in `ai_provider_configurations.model_params`. */
export interface ProviderModelParams {
  name: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

export interface AgentProviderRuntimeConfiguration {
  providerId: string
  modelId: string
  apiKey: string
  baseUrl: string
  revision: string
}

export type EmbeddingProtocol = 'openai' | 'ollama' | 'tei'

export interface EmbeddingProviderConfigurationSummary {
  providerId: string
  enabled: boolean
  isDefault: boolean
  baseUrl: string | null
  protocol: EmbeddingProtocol
  defaultModelId: string
  vectorDimension: number
  apiKeyHint: string | null
  createdAt: string
  updatedAt: string
}

export interface EmbeddingProviderRuntimeConfiguration {
  providerId: string
  modelId: string
  baseUrl: string
  protocol: EmbeddingProtocol
  vectorDimension: number
  apiKey: string
  revision: string
}
