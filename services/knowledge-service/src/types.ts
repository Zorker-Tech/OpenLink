export type BackendMode = 'standalone' | 'distributed'
export type BackendStatus = 'provisioning' | 'ready' | 'migrating' | 'stopped' | 'error'
export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'deleting' | 'deleted'

export interface KnowledgeBackend {
  id: string
  workspace_id: string
  mode: BackendMode
  status: BackendStatus
  endpoint: string | null
  collection_name: string
  vector_dimension: number
  embedding_provider: string | null
  embedding_model: string | null
  schema_version: number
  deployment_target: Record<string, unknown>
  last_error: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface KnowledgeCollection {
  id: string
  workspace_id: string
  created_by: string
  name: string
  slug: string
  description: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
}

export interface KnowledgeDocument {
  id: string
  workspace_id: string
  collection_id: string
  created_by: string
  title: string
  source_type: 'text' | 'file' | 'url' | 'markdown' | 'code'
  source_uri: string | null
  mime_type: string | null
  source_content?: string | null
  content_hash: string
  status: DocumentStatus
  chunk_count: number
  embedding_provider: string | null
  embedding_model: string | null
  metadata: Record<string, unknown>
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeChunk {
  id: string
  workspace_id: string
  collection_id: string
  document_id: string
  chunk_index: number
  content: string
  content_hash: string
  token_count: number
  zero_id: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface KnowledgeJob {
  id: string
  workspace_id: string
  collection_id: string | null
  document_id: string | null
  kind: string
  status: string
  payload: Record<string, unknown>
  last_error: string | null
  created_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface Workspace {
  id: string
  owner_id: string | null
  organization_id?: string | null
  scope_type?: 'personal' | 'organization'
}

export interface RequestContext {
  userId: string
  workspaceId?: string
  embedding?: EmbeddingRuntimeConfiguration
}

export interface EmbeddingRuntimeConfiguration {
  providerId: string
  modelId: string
  baseUrl: string
  protocol: 'openai' | 'ollama' | 'tei'
  vectorDimension: number
  apiKey: string
  revision: string
}

export interface SearchResult {
  id: string
  documentId: string
  collectionId: string
  content: string
  title: string
  score: number
  chunkIndex: number
  metadata: Record<string, unknown>
}

export interface KnowledgeDocumentInput {
  workspaceId: string
  userId: string
  collectionId: string
  title: string
  content: string
  sourceType?: KnowledgeDocument['source_type']
  sourceUri?: string
  mimeType?: string
  metadata?: Record<string, unknown>
}

export interface DistributedDeploymentInput {
  workspaceId: string
  userId: string
  host: string
  port: number
  user: string
  remoteRoot: string
  knownHosts: string
  privateKey: string
  endpoint: string
  zeroToken?: string
  chartReference?: string
  namespace?: string
  releaseName?: string
}
