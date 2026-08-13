import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { chunkText } from './chunking.js'
import { EmbeddingClient } from './embedding-client.js'
import { KnowledgeError, safeErrorMessage } from './errors.js'
import { ZeroClient } from './zero-client.js'
import { ZeroSshDeployer } from './zero-ssh-deployer.js'
import { ZokerbaseClient } from './zokerbase-client.js'
import type { DistributedDeploymentInput, EmbeddingRuntimeConfiguration, KnowledgeBackend, KnowledgeCollection, KnowledgeDocument, KnowledgeDocumentInput, KnowledgeJob, RequestContext, SearchResult } from './types.js'

export interface KnowledgeServiceOptions {
  zokerbase: ZokerbaseClient
  zero: ZeroClient
  embeddings: EmbeddingClient
  zeroCollection: string
  zeroDimension: number
  chunkSize: number
  chunkOverlap: number
  defaultZeroEndpoint: string
  defaultZeroHealthEndpoint: string
  defaultZeroToken: string
  providerSecretKey: string
  createZeroClient?: (input: { endpoint: string; healthEndpoint: string; token?: string; collection: string; dimension: number }) => ZeroClient
  distributedDeployer?: ZeroSshDeployer
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function encryptionKey(value: string): Buffer {
  const key = /^[a-f0-9]{64}$/i.test(value.trim()) ? Buffer.from(value.trim(), 'hex') : Buffer.from(value.trim(), 'base64')
  if (key.length !== 32) throw new KnowledgeError('INTERNAL_ERROR', 'OPENLINK_PROVIDER_SECRET_KEY must decode to 32 bytes', { status: 503 })
  return key
}

function encryptPrivateKey(privateKey: string, userId: string, backendId: string, secret: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  cipher.setAAD(Buffer.from(`openlink:provider:${userId}:knowledge-backend:${backendId}:v1`, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), version: 1 }
}

function safeText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new KnowledgeError('INVALID_BODY', `${label} must be a string`)
  const text = value.trim()
  if (!text || text.length > max) throw new KnowledgeError('INVALID_BODY', `${label} is empty or too long`)
  return text
}

function slug(value: string): string {
  const result = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)
  // Collection names are user-facing and commonly contain CJK characters.
  // Keep the slug URL-safe while avoiding a rejected create request when the
  // name has no ASCII transliteration.
  return result || `collection-${sha256(value.trim()).slice(0, 12)}`
}

function sshHost(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]-]{0,253}$/.test(value) || value.startsWith('-')) throw new KnowledgeError('INVALID_BODY', 'SSH host is invalid')
  return value
}

function sshUser(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value)) throw new KnowledgeError('INVALID_BODY', 'SSH user is invalid')
  return value
}

function sshRoot(value: string): string {
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) || value.includes('..')) throw new KnowledgeError('INVALID_BODY', 'SSH remoteRoot is invalid')
  return value.replace(/\/+$/, '') || '/'
}

export class KnowledgeService {
  private readonly options: KnowledgeServiceOptions
  private readonly defaultZero: ZeroClient
  private readonly zeroByBackend = new Map<string, ZeroClient>()
  constructor(options: KnowledgeServiceOptions) {
    this.options = options
    this.defaultZero = options.zero
  }

  private zeroForBackend(backend: KnowledgeBackend): ZeroClient {
    const cached = this.zeroByBackend.get(backend.id)
    if (cached) return cached
    if (!this.options.createZeroClient) return this.defaultZero
    const remote = backend.mode === 'distributed' && backend.endpoint ? backend.endpoint : this.options.defaultZeroEndpoint
    const client = this.options.createZeroClient({
      endpoint: remote,
      healthEndpoint: remote === this.options.defaultZeroEndpoint ? this.options.defaultZeroHealthEndpoint : remote,
      token: this.options.defaultZeroToken,
      collection: backend.collection_name,
      dimension: backend.vector_dimension,
    })
    this.zeroByBackend.set(backend.id, client)
    return client
  }

  private embeddingsFor(context: RequestContext): EmbeddingClient {
    const embedding = context.embedding
    if (!embedding) return this.options.embeddings
    return new EmbeddingClient({ baseUrl: embedding.baseUrl, apiKey: embedding.apiKey || undefined, model: embedding.modelId, dimension: embedding.vectorDimension, provider: embedding.providerId, protocol: embedding.protocol, timeoutMs: 30_000, allowDeterministic: false })
  }

  private async assertEmbeddingCompatible(context: RequestContext, backend: KnowledgeBackend): Promise<EmbeddingClient> {
    if (!context.embedding) {
      throw new KnowledgeError('EMBEDDING_NOT_CONFIGURED', 'Configure an embedding provider before writing or searching this knowledge base.', { status: 409, retryable: false })
    }
    const embeddings = this.embeddingsFor(context)
    if (backend.vector_dimension !== embeddings.dimension || backend.embedding_model !== embeddings.model || backend.embedding_provider !== embeddings.provider) {
      throw new KnowledgeError('BACKEND_NOT_READY', 'The selected embedding model or dimension differs from this knowledge index. Rebuild the index before writing or searching.', { status: 409, retryable: false })
    }
    return embeddings
  }

  async health(): Promise<{ zero: 'ready'; collection: string }> {
    await this.defaultZero.health()
    await this.defaultZero.ensureCollection()
    return { zero: 'ready', collection: this.options.zeroCollection }
  }

  async ensureBackend(context: RequestContext): Promise<KnowledgeBackend> {
    const workspaceId = safeText(context.workspaceId, 'workspaceId', 64)
    const userId = safeText(context.userId, 'userId', 64)
    await this.options.zokerbase.getWorkspace(workspaceId, userId)
    const existing = await this.options.zokerbase.getBackend(workspaceId)
    if (existing && existing.status === 'ready') {
      // A backend may be created before a user has selected an embedding
      // provider. Bind it to the first real configuration, before any
      // document can exist, instead of pretending that a fallback model is
      // installed locally.
      const configured = context.embedding && (!existing.embedding_provider || !existing.embedding_model)
        ? await this.options.zokerbase.updateBackend(existing.id, {
          collection_name: `openlink_kb_${workspaceId.replaceAll('-', '').slice(0, 24)}_${sha256(`${context.embedding.providerId}:${context.embedding.modelId}:${context.embedding.vectorDimension}`).slice(0, 12)}`,
          vector_dimension: context.embedding.vectorDimension,
          embedding_provider: context.embedding.providerId,
          embedding_model: context.embedding.modelId,
          updated_at: new Date().toISOString(),
        })
        : existing
      const target = this.zeroForBackend(configured)
      await target.health()
      await target.ensureCollection()
      return configured
    }
    if (!existing) {
      const embedding = context.embedding
      const collection = embedding
        ? `openlink_kb_${workspaceId.replaceAll('-', '').slice(0, 24)}_${sha256(`${embedding.providerId}:${embedding.modelId}:${embedding.vectorDimension}`).slice(0, 12)}`
        : `openlink_kb_${workspaceId.replaceAll('-', '').slice(0, 24)}_unconfigured`
      const created = await this.options.zokerbase.upsertBackend({
        workspace_id: workspaceId,
        mode: 'standalone',
        status: 'provisioning',
        endpoint: this.options.defaultZeroEndpoint,
        collection_name: collection,
        vector_dimension: embedding?.vectorDimension ?? this.options.zeroDimension,
        embedding_provider: embedding?.providerId ?? null,
        embedding_model: embedding?.modelId ?? null,
        created_by: userId,
      })
      await this.zeroForBackend(created).ensureCollection()
      return this.options.zokerbase.updateBackend(created.id, { status: 'ready', last_error: null, updated_at: new Date().toISOString() })
    }
    if (existing.mode === 'distributed' && existing.status !== 'ready') throw new KnowledgeError('BACKEND_NOT_READY', 'Distributed knowledge backend is not ready', { status: 409, retryable: true })
    await this.zeroForBackend(existing).ensureCollection()
    return this.options.zokerbase.updateBackend(existing.id, { status: 'ready', last_error: null, updated_at: new Date().toISOString() })
  }

  async getBackend(context: RequestContext): Promise<KnowledgeBackend> {
    return this.ensureBackend(context)
  }

  async listCollections(context: RequestContext): Promise<KnowledgeCollection[]> {
    await this.ensureBackend(context)
    return this.options.zokerbase.listCollections(context.workspaceId!)
  }

  async listDocuments(context: RequestContext, collectionId?: string): Promise<KnowledgeDocument[]> {
    await this.ensureBackend(context)
    if (collectionId) {
      const collection = await this.options.zokerbase.getCollection(collectionId, context.workspaceId)
      if (!collection) throw new KnowledgeError('NOT_FOUND', 'Knowledge collection was not found', { status: 404 })
    }
    return this.options.zokerbase.listWorkspaceDocuments(context.workspaceId!, collectionId)
  }

  async getDocument(context: RequestContext, documentId: string): Promise<{ document: KnowledgeDocument; collection: KnowledgeCollection; chunks: import('./types.js').KnowledgeChunk[] }> {
    await this.ensureBackend(context)
    const document = await this.options.zokerbase.getDocument(documentId, context.workspaceId)
    if (!document || document.status === 'deleted') throw new KnowledgeError('NOT_FOUND', 'Knowledge document was not found', { status: 404 })
    const collection = await this.options.zokerbase.getCollection(document.collection_id, context.workspaceId)
    if (!collection) throw new KnowledgeError('NOT_FOUND', 'Knowledge collection was not found', { status: 404 })
    return { document, collection, chunks: await this.options.zokerbase.listDocumentChunks(document.id) }
  }

  async createCollection(context: RequestContext, input: { name: unknown; slug?: unknown; description?: unknown }): Promise<KnowledgeCollection> {
    await this.ensureBackend(context)
    const name = safeText(input.name, 'name', 120)
    const collectionSlug = input.slug === undefined ? slug(name) : safeText(input.slug, 'slug', 120)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(collectionSlug)) throw new KnowledgeError('INVALID_BODY', 'Collection slug is invalid')
    const description = input.description === undefined ? '' : typeof input.description === 'string' ? input.description.trim() : safeText(input.description, 'description', 4_000)
    if (description.length > 4_000) throw new KnowledgeError('INVALID_BODY', 'description is too long')
    return this.options.zokerbase.createCollection({ workspace_id: context.workspaceId, created_by: context.userId, name, slug: collectionSlug, description })
  }

  async deleteCollection(context: RequestContext, collectionId: string): Promise<void> {
    await this.options.zokerbase.assertWorkspaceAdmin(context.workspaceId!, context.userId)
    const collection = await this.options.zokerbase.getCollection(collectionId, context.workspaceId)
    if (!collection) throw new KnowledgeError('NOT_FOUND', 'Knowledge collection was not found', { status: 404 })
    const backend = await this.ensureBackend(context)
    const documents = await this.options.zokerbase.listWorkspaceDocuments(context.workspaceId!, collection.id)
    await Promise.all(documents.map((document) => this.zeroForBackend(backend).deleteDocument(document.workspace_id, collection.id, document.id).catch(() => undefined)))
    await this.options.zokerbase.deleteCollection(collection.id)
  }

  async ingestDocument(context: RequestContext, input: KnowledgeDocumentInput): Promise<{ document: KnowledgeDocument; job: KnowledgeJob }> {
    if (input.workspaceId !== context.workspaceId || input.userId !== context.userId) throw new KnowledgeError('AUTH_DENIED', 'Request context does not match the authenticated user', { status: 403 })
    const backend = await this.ensureBackend(context)
    const embeddings = await this.assertEmbeddingCompatible(context, backend)
    const collection = await this.options.zokerbase.getCollection(input.collectionId, input.workspaceId)
    if (!collection || collection.status !== 'active') throw new KnowledgeError('NOT_FOUND', 'Knowledge collection was not found', { status: 404 })
    const title = safeText(input.title, 'title', 300)
    const content = safeText(input.content, 'content', 10_000_000)
    const sourceType = input.sourceType || 'text'
    const contentHash = sha256(content)
    if (!['text', 'file', 'url', 'markdown', 'code'].includes(sourceType)) throw new KnowledgeError('INVALID_BODY', 'sourceType is invalid')
    const document = await this.options.zokerbase.createDocument({
      workspace_id: input.workspaceId,
      collection_id: input.collectionId,
      created_by: input.userId,
      title,
      source_type: sourceType,
      source_uri: input.sourceUri || null,
      mime_type: input.mimeType || null,
      source_content: content,
      content_hash: contentHash,
      status: 'queued',
      embedding_provider: embeddings.provider,
      embedding_model: embeddings.model,
      metadata: input.metadata || {},
    })
    const job = await this.options.zokerbase.createJob({ workspace_id: input.workspaceId, collection_id: input.collectionId, document_id: document.id, kind: 'ingest', status: 'queued', payload: { backendId: backend.id }, created_by: input.userId })
    void this.processIngest(job.id, document.id, input.workspaceId, input.collectionId, content, embeddings).catch((error) => {
      console.error(`Knowledge ingest ${job.id} failed: ${safeErrorMessage(error)}`)
    })
    return { document, job }
  }

  private async processIngest(jobId: string, documentId: string, workspaceId: string, collectionId: string, content: string, embeddings: EmbeddingClient): Promise<void> {
    await this.options.zokerbase.updateJob(jobId, { status: 'running', started_at: new Date().toISOString() })
    await this.options.zokerbase.updateDocument(documentId, { status: 'processing', last_error: null, updated_at: new Date().toISOString() })
    try {
      const chunks = chunkText(content, this.options.chunkSize, this.options.chunkOverlap)
      if (chunks.length === 0) throw new KnowledgeError('INGEST_FAILED', 'Document contains no indexable text')
      const vectors: number[][] = []
      for (let start = 0; start < chunks.length; start += 64) vectors.push(...await embeddings.embed(chunks.slice(start, start + 64).map((chunk) => chunk.content)))
      const backend = await this.options.zokerbase.getBackend(workspaceId)
      if (!backend) throw new KnowledgeError('BACKEND_NOT_READY', 'Knowledge backend is not ready', { status: 409, retryable: true })
      if (vectors.some((vector) => vector.length !== backend.vector_dimension)) throw new KnowledgeError('INGEST_FAILED', 'Embedding dimension mismatch')
      await this.zeroForBackend(backend).deleteDocument(workspaceId, collectionId, documentId).catch(() => undefined)
      await this.options.zokerbase.deleteChunks(documentId)
      const zeroRows = chunks.map((chunk, index) => ({ id: `${documentId}:${chunk.index}`, vector: vectors[index], workspace_id: workspaceId, collection_id: collectionId, document_id: documentId, content_hash: chunk.hash }))
      await this.zeroForBackend(backend).upsert(zeroRows)
      await this.options.zokerbase.insertChunks(chunks.map((chunk) => ({ workspace_id: workspaceId, collection_id: collectionId, document_id: documentId, chunk_index: chunk.index, content: chunk.content, content_hash: chunk.hash, token_count: chunk.tokenCount, zero_id: `${documentId}:${chunk.index}`, metadata: {} })))
      await this.options.zokerbase.updateDocument(documentId, { status: 'ready', chunk_count: chunks.length, last_error: null, updated_at: new Date().toISOString() })
      await this.options.zokerbase.updateJob(jobId, { status: 'succeeded', completed_at: new Date().toISOString(), last_error: null })
    } catch (error) {
      const message = safeErrorMessage(error)
      await this.options.zokerbase.updateDocument(documentId, { status: 'failed', last_error: message, updated_at: new Date().toISOString() }).catch(() => undefined)
      await this.options.zokerbase.updateJob(jobId, { status: 'failed', completed_at: new Date().toISOString(), last_error: message }).catch(() => undefined)
    }
  }

  async deleteDocument(context: RequestContext, documentId: string): Promise<KnowledgeJob> {
    await this.ensureBackend(context)
    const document = await this.options.zokerbase.getDocument(documentId, context.workspaceId)
    if (!document) throw new KnowledgeError('NOT_FOUND', 'Document was not found', { status: 404 })
    const job = await this.options.zokerbase.createJob({ workspace_id: context.workspaceId, collection_id: document.collection_id, document_id: document.id, kind: 'delete', status: 'queued', created_by: context.userId })
    void this.processDelete(job.id, document).catch((error) => console.error(`Knowledge delete ${job.id} failed: ${safeErrorMessage(error)}`))
    return job
  }

  private async processDelete(jobId: string, document: KnowledgeDocument): Promise<void> {
    await this.options.zokerbase.updateJob(jobId, { status: 'running', started_at: new Date().toISOString() })
    await this.options.zokerbase.updateDocument(document.id, { status: 'deleting', updated_at: new Date().toISOString() })
    try {
      const backend = await this.options.zokerbase.getBackend(document.workspace_id)
      if (!backend) throw new KnowledgeError('BACKEND_NOT_READY', 'Knowledge backend is not ready', { status: 409, retryable: true })
      await this.zeroForBackend(backend).deleteDocument(document.workspace_id, document.collection_id, document.id)
      await this.options.zokerbase.deleteChunks(document.id)
      await this.options.zokerbase.updateDocument(document.id, { status: 'deleted', chunk_count: 0, updated_at: new Date().toISOString() })
      await this.options.zokerbase.updateJob(jobId, { status: 'succeeded', completed_at: new Date().toISOString() })
    } catch (error) {
      const message = safeErrorMessage(error)
      await this.options.zokerbase.updateDocument(document.id, { status: 'failed', last_error: message, updated_at: new Date().toISOString() }).catch(() => undefined)
      await this.options.zokerbase.updateJob(jobId, { status: 'failed', completed_at: new Date().toISOString(), last_error: message }).catch(() => undefined)
    }
  }

  async search(context: RequestContext, collectionId: string, query: string, limit = 10): Promise<SearchResult[]> {
    const backend = await this.ensureBackend(context)
    const embeddings = await this.assertEmbeddingCompatible(context, backend)
    const collection = await this.options.zokerbase.getCollection(collectionId, context.workspaceId)
    if (!collection) throw new KnowledgeError('NOT_FOUND', 'Knowledge collection was not found', { status: 404 })
    const text = safeText(query, 'query', 20_000)
    const safeLimit = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 10, 1), 100)
    const [vector] = await embeddings.embed([text])
    const hits = await this.zeroForBackend(backend).search(context.workspaceId!, collectionId, vector, safeLimit)
    const ids = hits.map((hit) => hit.id).filter((id): id is string => typeof id === 'string')
    const chunks = await this.options.zokerbase.listChunksByZeroIds(ids)
    const documents = await this.options.zokerbase.listDocuments([...new Set(chunks.map((chunk) => chunk.document_id))])
    const documentsById = new Map(documents.map((document) => [document.id, document]))
    const chunksByZeroId = new Map(chunks.map((chunk) => [chunk.zero_id, chunk]))
    return hits.flatMap((hit) => {
      const chunk = chunksByZeroId.get(hit.id)
      const document = chunk ? documentsById.get(chunk.document_id) : undefined
      if (!chunk || !document || document.status !== 'ready') return []
      return [{ id: chunk.zero_id, documentId: document.id, collectionId: chunk.collection_id, content: chunk.content, title: document.title, score: hit.score ?? hit.distance ?? 0, chunkIndex: chunk.chunk_index, metadata: { ...document.metadata, ...chunk.metadata } }]
    })
  }

  async getJob(context: RequestContext, jobId: string): Promise<KnowledgeJob> {
    const job = await this.options.zokerbase.getJob(jobId)
    if (!job) throw new KnowledgeError('NOT_FOUND', 'Knowledge job was not found', { status: 404 })
    await this.options.zokerbase.getWorkspace(job.workspace_id, context.userId)
    return job
  }

  async requestDistributedDeployment(input: DistributedDeploymentInput): Promise<KnowledgeJob> {
    if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) throw new KnowledgeError('INVALID_BODY', 'SSH port is invalid')
    input = { ...input, host: sshHost(input.host), user: sshUser(input.user), remoteRoot: sshRoot(input.remoteRoot), knownHosts: safeText(input.knownHosts, 'knownHosts', 1_000_000), privateKey: safeText(input.privateKey, 'privateKey', 32_768) }
    const endpoint = safeText(input.endpoint, 'endpoint', 512)
    const chartReference = safeText(input.chartReference, 'chartReference', 512)
    input = { ...input, endpoint, chartReference }
    await this.options.zokerbase.assertWorkspaceAdmin(input.workspaceId, input.userId)
    const backend = await this.ensureBackend({ workspaceId: input.workspaceId, userId: input.userId })
    const encrypted = encryptPrivateKey(input.privateKey, input.userId, backend.id, this.options.providerSecretKey)
    // SSH/Helm execution is deliberately isolated behind a deployment worker.
    // The persisted job lets the future worker perform the safe
    // new-cluster→migrate→validate→cutover sequence without making a web
    // request hold an SSH connection open.
    const deployment = await this.options.zokerbase.createDeployment({
      workspace_id: input.workspaceId,
      backend_id: backend.id,
      requested_by: input.userId,
      mode: 'distributed',
      target: {
        host: input.host,
        port: input.port,
        user: input.user,
        remoteRoot: input.remoteRoot,
        namespace: input.namespace || 'openlink-knowledge',
        releaseName: input.releaseName || 'openlink-zero',
      },
      status: 'queued',
    })
    await this.options.zokerbase.updateBackend(backend.id, {
      mode: 'distributed',
      status: 'migrating',
      ssh_host: input.host,
      ssh_port: input.port,
      ssh_user: input.user,
      ssh_remote_root: input.remoteRoot,
      ssh_known_hosts: input.knownHosts,
      ssh_encrypted_private_key: encrypted.ciphertext,
      ssh_private_key_iv: encrypted.iv,
      ssh_private_key_tag: encrypted.tag,
      ssh_encryption_version: encrypted.version,
      updated_at: new Date().toISOString(),
    })
    const job = await this.options.zokerbase.createJob({
      workspace_id: input.workspaceId,
      kind: 'distributed_deploy',
      status: 'queued',
      payload: {
        deploymentId: deployment.id,
        namespace: input.namespace || 'openlink-knowledge',
        releaseName: input.releaseName || 'openlink-zero',
        // The private key is never included in the job payload. It is stored
        // only in encrypted backend columns for the privileged deployment
        // worker.
      },
      created_by: input.userId,
    })
    await this.options.zokerbase.attachJobToDeployment(String(deployment.id), job.id)
    void this.processDistributedDeployment({ ...input, backendId: backend.id, deploymentId: String(deployment.id), jobId: job.id }).catch((error) => {
      console.error(`Knowledge distributed deployment ${deployment.id} failed: ${safeErrorMessage(error)}`)
    })
    return job
  }

  private async processDistributedDeployment(input: DistributedDeploymentInput & { backendId: string; deploymentId: string; jobId: string }): Promise<void> {
    const deployer = this.options.distributedDeployer
    const createClient = this.options.createZeroClient
    if (!deployer || !createClient) throw new KnowledgeError('DEPLOYMENT_UNAVAILABLE', 'Distributed deployment is not configured', { status: 503 })
    try {
      const backend = await this.options.zokerbase.getBackend(input.workspaceId)
      if (!backend) throw new KnowledgeError('BACKEND_NOT_READY', 'Knowledge backend is not ready', { status: 409, retryable: true })
      await this.options.zokerbase.updateDeployment(input.deploymentId, { status: 'connecting' })
      await this.options.zokerbase.updateJob(input.jobId, { status: 'running', started_at: new Date().toISOString() })
      await deployer.deploy({
        id: input.deploymentId,
        host: input.host,
        port: input.port,
        user: input.user,
        remoteRoot: input.remoteRoot,
        knownHosts: input.knownHosts,
        privateKey: input.privateKey,
        endpoint: input.endpoint,
        chartReference: input.chartReference || '',
        namespace: input.namespace || 'openlink-knowledge',
        releaseName: input.releaseName || 'openlink-zero',
      })
      await this.options.zokerbase.updateDeployment(input.deploymentId, { status: 'deploying' })
      const target = createClient({ endpoint: input.endpoint, healthEndpoint: input.endpoint, token: input.zeroToken, collection: backend.collection_name, dimension: backend.vector_dimension })
      await target.ensureCollection()
      const documents = await this.options.zokerbase.listReadyDocuments(input.workspaceId)
      await this.options.zokerbase.updateDeployment(input.deploymentId, { status: 'migrating' })
      for (const document of documents) {
        if (!document.source_content) throw new KnowledgeError('DEPLOYMENT_UNAVAILABLE', `Document ${document.id} has no source content for migration`, { status: 503 })
        const chunks = chunkText(document.source_content, this.options.chunkSize, this.options.chunkOverlap)
        const vectors: number[][] = []
        for (let start = 0; start < chunks.length; start += 64) vectors.push(...await this.options.embeddings.embed(chunks.slice(start, start + 64).map((chunk) => chunk.content)))
        if (vectors.some((vector) => vector.length !== backend.vector_dimension)) throw new KnowledgeError('DEPLOYMENT_UNAVAILABLE', 'Embedding dimension mismatch during distributed migration', { status: 503 })
        await target.upsert(chunks.map((chunk, index) => ({
          id: `${document.id}:${chunk.index}`,
          vector: vectors[index],
          workspace_id: document.workspace_id,
          collection_id: document.collection_id,
          document_id: document.id,
          content_hash: chunk.hash,
        })))
      }
      const probe = documents[0]
      if (probe?.source_content) {
        const [probeVector] = await this.options.embeddings.embed([probe.source_content.slice(0, this.options.chunkSize)])
        const probeHits = await target.search(input.workspaceId, probe.collection_id, probeVector, 1)
        if (probeHits.length === 0) throw new KnowledgeError('DEPLOYMENT_UNAVAILABLE', 'Distributed Zero validation search returned no result', { status: 503 })
      }
      await this.options.zokerbase.updateDeployment(input.deploymentId, { status: 'ready', endpoint: input.endpoint, last_error: null })
      await this.options.zokerbase.updateBackend(input.backendId, { mode: 'distributed', status: 'ready', endpoint: input.endpoint, last_error: null, updated_at: new Date().toISOString() })
      this.zeroByBackend.set(input.backendId, target)
      await this.options.zokerbase.updateJob(input.jobId, { status: 'succeeded', completed_at: new Date().toISOString(), last_error: null })
    } catch (error) {
      const message = safeErrorMessage(error)
      await this.options.zokerbase.updateDeployment(input.deploymentId, { status: 'failed', last_error: message }).catch(() => undefined)
      // Keep the old Standalone backend serving reads after a failed cutover;
      // the error remains visible to the admin as last_error and the failed
      // deployment/job records preserve the diagnostic.
      await this.options.zokerbase.updateBackend(input.backendId, { mode: 'standalone', status: 'ready', endpoint: this.options.defaultZeroEndpoint, last_error: message, updated_at: new Date().toISOString() }).catch(() => undefined)
      this.zeroByBackend.delete(input.backendId)
      await this.options.zokerbase.updateJob(input.jobId, { status: 'failed', completed_at: new Date().toISOString(), last_error: message }).catch(() => undefined)
      throw error
    }
  }
}
