export type EmbeddingProtocol = 'openai' | 'ollama' | 'tei'

export interface EmbeddingProviderDefinition {
  id: string
  name: string
  description: string
  baseUrl: string
  defaultModelId: string
  defaultDimension: number
  protocol: EmbeddingProtocol
  apiKeyLabel: string
  apiKeyRequired: boolean
  logo: string
  supportsLocalDownload?: boolean
}

const provider = (definition: EmbeddingProviderDefinition) => definition

/** Providers that produce text embeddings for Knowledge/Zero, never chat models. */
export const EMBEDDING_PROVIDERS = [
  provider({
    id: 'ollama', name: 'Ollama', description: '在本机运行 embedding 模型并通过 Ollama API 提供向量。',
    baseUrl: 'http://127.0.0.1:11434', defaultModelId: 'nomic-embed-text', defaultDimension: 768,
    protocol: 'ollama', apiKeyLabel: 'Ollama API Key（可选）', apiKeyRequired: false, logo: 'ollama', supportsLocalDownload: true,
  }),
  provider({
    id: 'huggingface', name: 'Hugging Face', description: '通过 Hugging Face Inference Providers 访问托管的 embedding 模型。',
    baseUrl: 'https://router.huggingface.co/v1', defaultModelId: 'sentence-transformers/all-MiniLM-L6-v2', defaultDimension: 384,
    protocol: 'openai', apiKeyLabel: 'Hugging Face Token', apiKeyRequired: true, logo: 'huggingface',
  }),
  provider({
    id: 'huggingface-tei', name: 'Hugging Face Local', description: '下载 Hugging Face 模型并由本地 Text Embeddings Inference（TEI）托管。',
    baseUrl: 'http://127.0.0.1:8080', defaultModelId: 'sentence-transformers/all-MiniLM-L6-v2', defaultDimension: 384,
    protocol: 'tei', apiKeyLabel: 'TEI API Key（可选）', apiKeyRequired: false, logo: 'huggingface', supportsLocalDownload: true,
  }),
  provider({
    id: 'openai', name: 'OpenAI', description: '通过 OpenAI Embeddings API 生成知识库向量。',
    baseUrl: 'https://api.openai.com/v1', defaultModelId: 'text-embedding-3-small', defaultDimension: 1536,
    protocol: 'openai', apiKeyLabel: 'OpenAI API Key', apiKeyRequired: true, logo: 'openai',
  }),
  provider({
    id: 'openai-compatible', name: 'OpenAI Compatible', description: '连接任意兼容 OpenAI /v1/embeddings 协议的向量服务。',
    baseUrl: '', defaultModelId: '', defaultDimension: 1536,
    protocol: 'openai', apiKeyLabel: 'API Key（可选）', apiKeyRequired: false, logo: 'openai',
  }),
] as const satisfies readonly EmbeddingProviderDefinition[]

const providerMap = new Map<string, EmbeddingProviderDefinition>(EMBEDDING_PROVIDERS.map((item) => [item.id, item]))

export function getEmbeddingProvider(providerId: string) { return providerMap.get(providerId) ?? null }

export function isEmbeddingProviderId(providerId: string): boolean { return providerMap.has(providerId) }
