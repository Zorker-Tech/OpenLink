export type KnowledgeErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_DENIED'
  | 'INVALID_BODY'
  | 'INVALID_ID'
  | 'NOT_FOUND'
  | 'BACKEND_NOT_READY'
  | 'ZERO_UNAVAILABLE'
  | 'EMBEDDING_NOT_CONFIGURED'
  | 'EMBEDDING_FAILED'
  | 'INGEST_FAILED'
  | 'DEPLOYMENT_UNAVAILABLE'
  | 'INTERNAL_ERROR'

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode
  readonly status: number
  readonly retryable: boolean

  constructor(code: KnowledgeErrorCode, message: string, options?: { status?: number; retryable?: boolean }) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
    this.status = options?.status ?? 400
    this.retryable = options?.retryable ?? false
  }
}

export function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
}
