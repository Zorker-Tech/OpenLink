import { KnowledgeError, safeErrorMessage } from './errors.js'
import type { KnowledgeBackend, KnowledgeChunk, KnowledgeCollection, KnowledgeDocument, KnowledgeJob, Workspace } from './types.js'

type JsonRecord = Record<string, unknown>

function queryEq(value: string): string {
  return `eq.${encodeURIComponent(value)}`
}

function uuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new KnowledgeError('INVALID_ID', `${label} is invalid`)
  return value
}

export interface ZokerbaseClientOptions {
  url: string
  serviceKey: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export class ZokerbaseClient {
  private readonly baseUrl: string
  private readonly key: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(options: ZokerbaseClientOptions) {
    this.baseUrl = options.url.replace(/\/$/, '')
    this.key = options.serviceKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  private async request<T>(path: string, init: RequestInit = {}, profile = 'openlink'): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Accept-Profile': profile,
          'Content-Profile': profile,
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new KnowledgeError('INTERNAL_ERROR', `ZOKERBASE request failed: ${safeErrorMessage(error)}`, { status: 503, retryable: true })
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 1_000)
      throw new KnowledgeError('INTERNAL_ERROR', `ZOKERBASE request failed (${response.status}): ${detail}`, { status: 503, retryable: response.status >= 500 })
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  async getWorkspace(workspaceId: string, userId: string): Promise<Workspace> {
    uuid(workspaceId, 'workspaceId'); uuid(userId, 'userId')
    const query = new URLSearchParams({ select: 'id,owner_id,organization_id,scope_type', id: queryEq(workspaceId) })
    const rows = await this.request<Workspace[]>(`/rest/v1/workspaces?${query}`)
    const workspace = rows[0]
    if (!workspace) throw new KnowledgeError('AUTH_DENIED', 'Workspace was not found', { status: 403 })
    if (workspace.scope_type === 'personal') {
      if (workspace.owner_id !== userId) throw new KnowledgeError('AUTH_DENIED', 'User cannot access this workspace', { status: 403 })
    } else if (workspace.scope_type === 'organization') {
      const membershipQuery = new URLSearchParams({ select: 'organization_id', organization_id: queryEq(workspace.organization_id || ''), user_id: queryEq(userId) })
      const members = await this.request<JsonRecord[]>(`/rest/v1/organization_members?${membershipQuery}`)
      if (members.length === 0) throw new KnowledgeError('AUTH_DENIED', 'User is not a workspace member', { status: 403 })
    }
    return workspace
  }

  async assertWorkspaceAdmin(workspaceId: string, userId: string): Promise<Workspace> {
    const workspace = await this.getWorkspace(workspaceId, userId)
    if (workspace.scope_type === 'personal') return workspace
    const query = new URLSearchParams({
      select: 'organization_id,role',
      organization_id: queryEq(workspace.organization_id || ''),
      user_id: queryEq(userId),
      role: 'in.(owner,admin)',
    })
    const rows = await this.request<JsonRecord[]>(`/rest/v1/organization_members?${query}`)
    if (rows.length === 0) throw new KnowledgeError('AUTH_DENIED', 'Workspace administrator access is required', { status: 403 })
    return workspace
  }

  async getBackend(workspaceId: string): Promise<KnowledgeBackend | null> {
    uuid(workspaceId, 'workspaceId')
    const query = new URLSearchParams({ select: '*', workspace_id: queryEq(workspaceId), limit: '1' })
    const rows = await this.request<KnowledgeBackend[]>(`/rest/v1/knowledge_backends?${query}`)
    return rows[0] ?? null
  }

  async upsertBackend(values: JsonRecord): Promise<KnowledgeBackend> {
    const rows = await this.request<KnowledgeBackend[]>('/rest/v1/knowledge_backends?on_conflict=workspace_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(values),
    })
    const row = rows[0]
    if (!row) throw new KnowledgeError('INTERNAL_ERROR', 'ZOKERBASE did not return the knowledge backend', { status: 503, retryable: true })
    return row
  }

  async updateBackend(id: string, values: JsonRecord): Promise<KnowledgeBackend> {
    const query = new URLSearchParams({ id: queryEq(uuid(id, 'backendId')), select: '*' })
    const rows = await this.request<KnowledgeBackend[]>(`/rest/v1/knowledge_backends?${query}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values),
    })
    if (!rows[0]) throw new KnowledgeError('NOT_FOUND', 'Knowledge backend was not found', { status: 404 })
    return rows[0]
  }

  async createDeployment(values: JsonRecord): Promise<JsonRecord> {
    const rows = await this.request<JsonRecord[]>('/rest/v1/knowledge_backend_deployments', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values),
    })
    if (!rows[0]) throw new KnowledgeError('INTERNAL_ERROR', 'ZOKERBASE did not return the deployment', { status: 503, retryable: true })
    return rows[0]
  }

  async listCollections(workspaceId: string): Promise<KnowledgeCollection[]> {
    const query = new URLSearchParams({ select: '*', workspace_id: queryEq(workspaceId), order: 'updated_at.desc' })
    return this.request<KnowledgeCollection[]>(`/rest/v1/knowledge_collections?${query}`)
  }

  async listJobs(workspaceId: string, status?: string): Promise<KnowledgeJob[]> {
    const query = new URLSearchParams({ select: '*', workspace_id: queryEq(uuid(workspaceId, 'workspaceId')), order: 'created_at.asc' })
    if (status) query.set('status', queryEq(status))
    return this.request<KnowledgeJob[]>(`/rest/v1/knowledge_jobs?${query}`)
  }

  async getCollection(collectionId: string, workspaceId?: string): Promise<KnowledgeCollection | null> {
    uuid(collectionId, 'collectionId')
    const params = new URLSearchParams({ select: '*', id: queryEq(collectionId), limit: '1' })
    if (workspaceId) params.set('workspace_id', queryEq(uuid(workspaceId, 'workspaceId')))
    const rows = await this.request<KnowledgeCollection[]>(`/rest/v1/knowledge_collections?${params}`)
    return rows[0] ?? null
  }

  async createCollection(values: JsonRecord): Promise<KnowledgeCollection> {
    const rows = await this.request<KnowledgeCollection[]>('/rest/v1/knowledge_collections', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(values),
    })
    if (!rows[0]) throw new KnowledgeError('INTERNAL_ERROR', 'ZOKERBASE did not return the collection', { status: 503, retryable: true })
    return rows[0]
  }

  async deleteCollection(id: string): Promise<void> {
    const query = new URLSearchParams({ id: queryEq(uuid(id, 'collectionId')) })
    await this.request<undefined>(`/rest/v1/knowledge_collections?${query}`, { method: 'DELETE' })
  }

  async createDocument(values: JsonRecord): Promise<KnowledgeDocument> {
    const rows = await this.request<KnowledgeDocument[]>('/rest/v1/knowledge_documents', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values),
    })
    if (!rows[0]) throw new KnowledgeError('INTERNAL_ERROR', 'ZOKERBASE did not return the document', { status: 503, retryable: true })
    return rows[0]
  }

  async updateDocument(id: string, values: JsonRecord): Promise<KnowledgeDocument> {
    const query = new URLSearchParams({ id: queryEq(uuid(id, 'documentId')), select: '*' })
    const rows = await this.request<KnowledgeDocument[]>(`/rest/v1/knowledge_documents?${query}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values),
    })
    if (!rows[0]) throw new KnowledgeError('NOT_FOUND', 'Document was not found', { status: 404 })
    return rows[0]
  }

  async getDocument(id: string, workspaceId?: string): Promise<KnowledgeDocument | null> {
    const params = new URLSearchParams({ select: '*', id: queryEq(uuid(id, 'documentId')), limit: '1' })
    if (workspaceId) params.set('workspace_id', queryEq(uuid(workspaceId, 'workspaceId')))
    const rows = await this.request<KnowledgeDocument[]>(`/rest/v1/knowledge_documents?${params}`)
    return rows[0] ?? null
  }

  async insertChunks(values: JsonRecord[]): Promise<KnowledgeChunk[]> {
    return this.request<KnowledgeChunk[]>('/rest/v1/knowledge_chunks', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values),
    })
  }

  async deleteChunks(documentId: string): Promise<void> {
    const query = new URLSearchParams({ document_id: queryEq(uuid(documentId, 'documentId')) })
    await this.request<undefined>(`/rest/v1/knowledge_chunks?${query}`, { method: 'DELETE' })
  }

  async createJob(values: JsonRecord): Promise<KnowledgeJob> {
    const rows = await this.request<KnowledgeJob[]>('/rest/v1/knowledge_jobs', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values),
    })
    if (!rows[0]) throw new KnowledgeError('INTERNAL_ERROR', 'ZOKERBASE did not return the job', { status: 503, retryable: true })
    return rows[0]
  }

  async attachJobToDeployment(deploymentId: string, jobId: string): Promise<void> {
    const query = new URLSearchParams({ id: queryEq(deploymentId) })
    await this.request<undefined>(`/rest/v1/knowledge_backend_deployments?${query}`, { method: 'PATCH', body: JSON.stringify({ job_id: jobId, updated_at: new Date().toISOString() }) })
  }

  async updateJob(id: string, values: JsonRecord): Promise<void> {
    const query = new URLSearchParams({ id: queryEq(uuid(id, 'jobId')) })
    await this.request<undefined>(`/rest/v1/knowledge_jobs?${query}`, { method: 'PATCH', body: JSON.stringify(values) })
  }

  async getJob(id: string): Promise<KnowledgeJob | null> {
    const query = new URLSearchParams({ select: '*', id: queryEq(uuid(id, 'jobId')), limit: '1' })
    const rows = await this.request<KnowledgeJob[]>(`/rest/v1/knowledge_jobs?${query}`)
    return rows[0] ?? null
  }

  async deleteDocument(id: string): Promise<void> {
    const query = new URLSearchParams({ id: queryEq(uuid(id, 'documentId')) })
    await this.request<undefined>(`/rest/v1/knowledge_documents?${query}`, { method: 'DELETE' })
  }

  async listChunksByZeroIds(ids: string[]): Promise<KnowledgeChunk[]> {
    if (ids.length === 0) return []
    const safe = ids.filter((id) => /^[0-9a-f-]{36}:[0-9]+$/i.test(id))
    if (safe.length !== ids.length) throw new KnowledgeError('INVALID_ID', 'Zero entity id is invalid')
    const values = safe.map((id) => `"${id.replaceAll('"', '\\"')}"`).join(',')
    const query = new URLSearchParams({ select: '*', zero_id: `in.(${values})` })
    return this.request<KnowledgeChunk[]>(`/rest/v1/knowledge_chunks?${query}`)
  }

  async listDocuments(ids: string[]): Promise<KnowledgeDocument[]> {
    if (ids.length === 0) return []
    const values = ids.map((id) => uuid(id, 'documentId')).join(',')
    const query = new URLSearchParams({ select: '*', id: `in.(${values})` })
    return this.request<KnowledgeDocument[]>(`/rest/v1/knowledge_documents?${query}`)
  }

  async listWorkspaceDocuments(workspaceId: string, collectionId?: string): Promise<KnowledgeDocument[]> {
    const query = new URLSearchParams({
      select: '*',
      workspace_id: queryEq(uuid(workspaceId, 'workspaceId')),
      status: 'not.in.(deleted,deleting)',
      order: 'updated_at.desc',
    })
    if (collectionId) query.set('collection_id', queryEq(uuid(collectionId, 'collectionId')))
    return this.request<KnowledgeDocument[]>(`/rest/v1/knowledge_documents?${query}`)
  }

  async listDocumentChunks(documentId: string): Promise<KnowledgeChunk[]> {
    const query = new URLSearchParams({
      select: '*',
      document_id: queryEq(uuid(documentId, 'documentId')),
      order: 'chunk_index.asc',
    })
    return this.request<KnowledgeChunk[]>(`/rest/v1/knowledge_chunks?${query}`)
  }

  async listReadyDocuments(workspaceId: string): Promise<KnowledgeDocument[]> {
    const query = new URLSearchParams({ select: '*', workspace_id: queryEq(uuid(workspaceId, 'workspaceId')), status: 'eq.ready', order: 'updated_at.asc' })
    return this.request<KnowledgeDocument[]>(`/rest/v1/knowledge_documents?${query}`)
  }

  async updateDeployment(id: string, values: JsonRecord): Promise<void> {
    const query = new URLSearchParams({ id: queryEq(uuid(id, 'deploymentId')) })
    await this.request<undefined>(`/rest/v1/knowledge_backend_deployments?${query}`, { method: 'PATCH', body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) })
  }
}
