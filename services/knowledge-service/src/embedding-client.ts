import { createHash } from 'node:crypto'
import { KnowledgeError, safeErrorMessage } from './errors.js'

export interface EmbeddingClientOptions {
  baseUrl: string
  apiKey?: string
  model: string
  dimension: number
  provider: string
  timeoutMs: number
  allowDeterministic: boolean
  protocol?: 'openai' | 'ollama' | 'tei'
  fetch?: typeof globalThis.fetch
}

function deterministicEmbedding(input: string, dimension: number): number[] {
  const output = new Array<number>(dimension).fill(0)
  const bytes = createHash('sha512').update(input).digest()
  for (let index = 0; index < dimension; index += 1) output[index] = ((bytes[index % bytes.length] / 255) * 2) - 1
  const norm = Math.sqrt(output.reduce((sum, value) => sum + value * value, 0)) || 1
  return output.map((value) => value / norm)
}

export class EmbeddingClient {
  private readonly options: EmbeddingClientOptions
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: EmbeddingClientOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  get provider() { return this.options.provider }
  get model() { return this.options.model }
  get dimension() { return this.options.dimension }

  private endpoint() {
    const baseUrl = this.options.baseUrl.replace(/\/$/, '')
    if (this.options.protocol === 'ollama') return `${baseUrl}/api/embed`
    if (this.options.protocol === 'tei') return `${baseUrl}/embed`
    return `${baseUrl}/embeddings`
  }

  async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) return []
    const requiresApiKey = (this.options.protocol ?? 'openai') === 'openai'
    if (!this.options.apiKey && requiresApiKey) {
      if (!this.options.allowDeterministic) throw new KnowledgeError('EMBEDDING_NOT_CONFIGURED', 'Embedding API key is not configured', { status: 503 })
      return input.map((value) => deterministicEmbedding(value, this.options.dimension))
    }
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: { ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}), 'Content-Type': 'application/json' },
        body: JSON.stringify(this.options.protocol === 'tei' ? { inputs: input } : { model: this.options.model, input }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error) {
      throw new KnowledgeError('EMBEDDING_FAILED', `Embedding provider request failed: ${safeErrorMessage(error)}`, { status: 503, retryable: true })
    }
    if (!response.ok) throw new KnowledgeError('EMBEDDING_FAILED', `Embedding provider returned ${response.status}`, { status: 503, retryable: response.status >= 500 })
    const payload = await response.json().catch(() => null) as { data?: Array<{ index?: number; embedding?: unknown }>; embeddings?: unknown } | number[][] | null
    if (this.options.protocol === 'ollama') {
      const embeddings = (payload as { embeddings?: unknown } | null)?.embeddings
      if (!Array.isArray(embeddings) || embeddings.length !== input.length || embeddings.some((value) => !Array.isArray(value) || value.length !== this.options.dimension || value.some((item) => typeof item !== 'number' || !Number.isFinite(item)))) throw new KnowledgeError('EMBEDDING_FAILED', `Embedding dimension does not match configured dimension ${this.options.dimension}`, { status: 503 })
      return embeddings as number[][]
    }
    if (this.options.protocol === 'tei') {
      const embeddings = payload
      if (!Array.isArray(embeddings) || embeddings.length !== input.length || embeddings.some((value) => !Array.isArray(value) || value.length !== this.options.dimension || value.some((item) => typeof item !== 'number' || !Number.isFinite(item)))) throw new KnowledgeError('EMBEDDING_FAILED', `Embedding dimension does not match configured dimension ${this.options.dimension}`, { status: 503 })
      return embeddings as number[][]
    }
    const rows = (payload as { data?: Array<{ index?: number; embedding?: unknown }> } | null)?.data
    if (!Array.isArray(rows) || rows.length !== input.length) throw new KnowledgeError('EMBEDDING_FAILED', 'Embedding provider returned an invalid response', { status: 503, retryable: true })
    const embeddings = rows.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((row) => row.embedding)
    if (embeddings.some((value) => !Array.isArray(value) || value.length !== this.options.dimension || value.some((item) => typeof item !== 'number' || !Number.isFinite(item)))) {
      throw new KnowledgeError('EMBEDDING_FAILED', `Embedding dimension does not match configured dimension ${this.options.dimension}`, { status: 503 })
    }
    return embeddings as number[][]
  }
}
