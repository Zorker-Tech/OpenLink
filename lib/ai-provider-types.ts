export interface AiProviderConfigurationSummary {
  providerId: string
  enabled: boolean
  isDefault: boolean
  baseUrl: string | null
  defaultModelId: string | null
  enabledModelIds: string[]
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

export interface AgentProviderRuntimeConfiguration {
  providerId: string
  modelId: string
  apiKey: string
  baseUrl: string
  revision: string
}
