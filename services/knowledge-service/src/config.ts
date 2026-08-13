import { resolve } from 'node:path'
import { KnowledgeError } from './errors.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new KnowledgeError('INTERNAL_ERROR', `${name} is required`, { status: 503, retryable: true })
  return value
}

function url(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
    return parsed.toString().replace(/\/$/, '')
  } catch {
    throw new KnowledgeError('INTERNAL_ERROR', `${name} is invalid`, { status: 503, retryable: true })
  }
}

function healthOrigin(name: string, fallback: string): string {
  const value = url(name, fallback)
  try {
    const parsed = new URL(value)
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    throw new KnowledgeError('INTERNAL_ERROR', `${name} is invalid`, { status: 503, retryable: true })
  }
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new KnowledgeError('INTERNAL_ERROR', `${name} is invalid`, { status: 503 })
  return parsed
}

export interface KnowledgeConfig {
  host: string
  port: number
  internalToken: string
  zokerbaseUrl: string
  zokerbaseServiceKey: string
  zeroUrl: string
  zeroHealthUrl: string
  zeroToken: string
  zeroCollection: string
  dimension: number
  embeddingBaseUrl: string
  embeddingApiKey?: string
  embeddingModel: string
  embeddingProvider: string
  embeddingProtocol: 'openai' | 'ollama' | 'tei'
  providerSecretKey: string
  requestTimeoutMs: number
  chunkSize: number
  chunkOverlap: number
  allowDeterministicEmbeddings: boolean
  runtimeRoot: string
}

export function loadConfig(): KnowledgeConfig {
  const zokerbaseUrl = url('OPENLINK_KNOWLEDGE_ZOKERBASE_URL', process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54380')
  const embeddingApiKey = process.env.OPENLINK_EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined
  return {
    host: process.env.OPENLINK_KNOWLEDGE_HOST?.trim() || '127.0.0.1',
    port: integer('OPENLINK_KNOWLEDGE_PORT', 43124, 1, 65_535),
    internalToken: required('OPENLINK_KNOWLEDGE_INTERNAL_TOKEN'),
    zokerbaseUrl,
    zokerbaseServiceKey: process.env.OPENLINK_KNOWLEDGE_ZOKERBASE_SERVICE_KEY?.trim() || required('OPENLINK_SUPABASE_SERVICE_ROLE_KEY'),
    zeroUrl: url('OPENLINK_ZERO_URL', 'http://127.0.0.1:19530'),
    zeroHealthUrl: healthOrigin('OPENLINK_ZERO_HEALTH_URL', process.env.OPENLINK_ZERO_HEALTH_URL || 'http://127.0.0.1:9091'),
    zeroToken: process.env.OPENLINK_ZERO_TOKEN?.trim() || 'root:Zero',
    zeroCollection: process.env.OPENLINK_ZERO_COLLECTION?.trim() || 'openlink_knowledge_chunks_v1',
    dimension: integer('OPENLINK_ZERO_DIMENSION', 1536, 2, 32_768),
    embeddingBaseUrl: url('OPENLINK_EMBEDDING_BASE_URL', 'https://api.openai.com/v1'),
    embeddingApiKey,
    embeddingModel: process.env.OPENLINK_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
    embeddingProvider: process.env.OPENLINK_EMBEDDING_PROVIDER?.trim() || 'openai-compatible',
    embeddingProtocol: embeddingProtocol(process.env.OPENLINK_EMBEDDING_PROTOCOL),
    providerSecretKey: required('OPENLINK_PROVIDER_SECRET_KEY'),
    requestTimeoutMs: integer('OPENLINK_KNOWLEDGE_REQUEST_TIMEOUT_MS', 30_000, 1_000, 300_000),
    chunkSize: integer('OPENLINK_KNOWLEDGE_CHUNK_SIZE', 1_200, 100, 100_000),
    chunkOverlap: integer('OPENLINK_KNOWLEDGE_CHUNK_OVERLAP', 160, 0, 10_000),
    allowDeterministicEmbeddings: process.env.OPENLINK_EMBEDDING_ALLOW_DETERMINISTIC === '1',
    runtimeRoot: resolve(process.env.OPENLINK_KNOWLEDGE_RUNTIME_ROOT?.trim() || '.openlink-runtime/knowledge'),
  }
}

function embeddingProtocol(value: string | undefined): 'openai' | 'ollama' | 'tei' {
  if (!value || value === 'openai') return 'openai'
  if (value === 'ollama' || value === 'tei') return value
  throw new KnowledgeError('INTERNAL_ERROR', 'OPENLINK_EMBEDDING_PROTOCOL is invalid', { status: 503 })
}
