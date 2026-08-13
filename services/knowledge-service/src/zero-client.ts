import { KnowledgeError, safeErrorMessage } from './errors.js'

interface ZeroClientOptions {
  url: string
  healthUrl: string
  token: string
  collection: string
  dimension: number
  timeoutMs: number
  fetch?: typeof globalThis.fetch
}

interface ZeroEntity {
  id: string
  vector: number[]
  workspace_id: string
  collection_id: string
  document_id: string
  content_hash: string
}

export interface ZeroSearchHit { id: string; distance?: number; score?: number }

interface ZeroField { name?: string; type?: string; params?: Array<{ key?: string; value?: string }> }
interface ZeroCollectionDescription { fields?: ZeroField[]; indexes?: Array<{ fieldName?: string; metricType?: string }> }

function escapeFilter(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export class ZeroClient {
  private readonly options: ZeroClientOptions
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: ZeroClientOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  private async request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.url}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.options.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error) {
      throw new KnowledgeError('ZERO_UNAVAILABLE', `Zero request failed: ${safeErrorMessage(error)}`, { status: 503, retryable: true })
    }
    if (!response.ok) throw new KnowledgeError('ZERO_UNAVAILABLE', `Zero returned ${response.status}: ${(await response.text().catch(() => '')).slice(0, 500)}`, { status: 503, retryable: response.status >= 500 })
    const payload = await response.json().catch(() => null) as { code?: number; message?: string; data?: T } | null
    if (!payload || (typeof payload.code === 'number' && payload.code !== 0)) throw new KnowledgeError('ZERO_UNAVAILABLE', payload?.message || 'Zero returned an invalid response', { status: 503, retryable: true })
    return (payload.data ?? payload) as T
  }

  async health(): Promise<void> {
    await this.requestHealth()
  }

  private async requestHealth(): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.options.healthUrl}/healthz`, { signal: AbortSignal.timeout(this.options.timeoutMs) })
      if (response.ok) return
      // Remote Distributed deployments commonly expose the REST API through
      // an ingress without forwarding the standalone 9091 health route. A
      // successful authenticated collection-list call is an equivalent
      // readiness signal for that topology.
      if (response.status === 404 && this.options.healthUrl === this.options.url) {
        await this.request('/v2/vectordb/collections/list', {})
        return
      }
      throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      throw new KnowledgeError('ZERO_UNAVAILABLE', `Zero health check failed: ${safeErrorMessage(error)}`, { status: 503, retryable: true })
    }
  }

  async ensureCollection(): Promise<void> {
    try {
      await this.request('/v2/vectordb/collections/create', {
        collectionName: this.options.collection,
        schema: {
          autoID: false,
          enableDynamicField: false,
          fields: [
            { fieldName: 'id', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: 128 } },
            { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: this.options.dimension } },
            { fieldName: 'workspace_id', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
            { fieldName: 'collection_id', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
            { fieldName: 'document_id', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
            { fieldName: 'content_hash', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
          ],
        },
        indexParams: [{ fieldName: 'vector', indexName: 'vector', metricType: 'COSINE', params: { index_type: 'AUTOINDEX' } }],
      })
    } catch (error) {
      // Zero returns a conflict for an existing collection. Describe it to
      // distinguish that expected case from a real schema or connectivity error.
      let description: ZeroCollectionDescription
      try {
        description = await this.request<ZeroCollectionDescription>('/v2/vectordb/collections/describe', { collectionName: this.options.collection })
      } catch {
        throw error
      }
      const vector = description.fields?.find((field) => field.name === 'vector')
      const dimension = vector?.params?.find((param) => param.key === 'dim')?.value
      const index = description.indexes?.find((candidate) => candidate.fieldName === 'vector')
      if (vector?.type !== 'FloatVector' || dimension !== String(this.options.dimension) || index?.metricType !== 'COSINE') {
        throw new KnowledgeError('ZERO_UNAVAILABLE', `Zero collection ${this.options.collection} has an incompatible schema`, { status: 503 })
      }
    }
    await this.request('/v2/vectordb/collections/load', { collectionName: this.options.collection })
  }

  async upsert(rows: ZeroEntity[]): Promise<void> {
    if (rows.length === 0) return
    await this.request('/v2/vectordb/entities/upsert', { collectionName: this.options.collection, data: rows })
  }

  async deleteDocument(workspaceId: string, collectionId: string, documentId: string): Promise<void> {
    const filter = `workspace_id == ${escapeFilter(workspaceId)} and collection_id == ${escapeFilter(collectionId)} and document_id == ${escapeFilter(documentId)}`
    await this.request('/v2/vectordb/entities/delete', { collectionName: this.options.collection, filter })
  }

  async search(workspaceId: string, collectionId: string, vector: number[], limit: number): Promise<ZeroSearchHit[]> {
    const filter = `workspace_id == ${escapeFilter(workspaceId)} and collection_id == ${escapeFilter(collectionId)}`
    const data = await this.request<ZeroSearchHit[]>('/v2/vectordb/entities/search', {
      collectionName: this.options.collection,
      data: [vector],
      annsField: 'vector',
      filter,
      limit,
      outputFields: ['id', 'workspace_id', 'collection_id', 'document_id', 'content_hash'],
      searchParams: { metricType: 'COSINE', params: {} },
    })
    return Array.isArray(data) ? data : []
  }
}
