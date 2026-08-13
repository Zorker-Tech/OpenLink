import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import { KnowledgeError, safeErrorMessage } from './errors.js'
import type { KnowledgeService } from './knowledge-service.js'

const MAX_BODY_BYTES = 12 * 1024 * 1024

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(payload)
}

function bearer(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') && value.slice(7) === token
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new KnowledgeError('INVALID_BODY', 'Request body is too large', { status: 413 })
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new KnowledgeError('INVALID_BODY', 'Request body is not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new KnowledgeError('INVALID_BODY', 'Request body must be an object')
  return parsed as Record<string, unknown>
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new KnowledgeError('INVALID_BODY', `${key} is required`)
  return value.trim()
}

function userContext(input: Record<string, unknown>, request?: IncomingMessage) {
  return { userId: stringField(input, 'userId'), workspaceId: stringField(input, 'workspaceId'), embedding: embeddingContext(input) ?? embeddingFromHeader(request) }
}

function embeddingContext(input: Record<string, unknown>) {
  const value = input.embedding
  if (!value) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KnowledgeError('INVALID_BODY', 'embedding is invalid')
  const config = value as Record<string, unknown>
  const protocol = config.protocol
  const vectorDimension = Number(config.vectorDimension)
  if (!['openai', 'ollama', 'tei'].includes(String(protocol)) || !Number.isSafeInteger(vectorDimension) || vectorDimension < 2 || vectorDimension > 32_768) throw new KnowledgeError('INVALID_BODY', 'embedding is invalid')
  return {
    providerId: stringField(config, 'providerId'), modelId: stringField(config, 'modelId'), baseUrl: stringField(config, 'baseUrl'),
    protocol: protocol as 'openai' | 'ollama' | 'tei', vectorDimension, apiKey: typeof config.apiKey === 'string' ? config.apiKey : '', revision: typeof config.revision === 'string' ? config.revision : '',
  }
}

function workspaceFromUrl(url: URL): { userId: string; workspaceId: string } {
  const userId = url.searchParams.get('userId') || ''
  const workspaceId = url.searchParams.get('workspaceId') || url.pathname.split('/').at(-1) || ''
  if (!userId || !workspaceId) throw new KnowledgeError('INVALID_BODY', 'userId and workspaceId are required')
  return { userId, workspaceId }
}

function pathParts(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
}

export interface KnowledgeHttpOptions {
  service: KnowledgeService
  host: string
  port: number
  internalToken: string
}

export function createKnowledgeHttpServer(options: KnowledgeHttpOptions) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
      if (request.method === 'GET' && url.pathname === '/healthz') {
        const health = await options.service.health()
        json(response, 200, { ok: true, ...health })
        return
      }
      if (!bearer(request, options.internalToken)) {
        json(response, 401, { error: { code: 'AUTH_DENIED', message: 'Knowledge Service internal token is invalid', retryable: false } })
        return
      }
      const parts = pathParts(url)
      if (parts[0] !== 'v1' || parts[1] !== 'knowledge') throw new KnowledgeError('NOT_FOUND', 'Knowledge endpoint was not found', { status: 404 })

      if (request.method === 'GET' && parts[2] === 'backends' && parts.length === 3) {
        const context = { ...workspaceFromUrl(url), embedding: embeddingFromHeader(request) }
        json(response, 200, { backend: await options.service.getBackend(context) })
        return
      }
      if (request.method === 'GET' && parts[2] === 'collections' && parts.length === 3) {
        const context = { ...workspaceFromUrl(url), embedding: embeddingFromHeader(request) }
        json(response, 200, { collections: await options.service.listCollections(context) })
        return
      }
      if (request.method === 'POST' && parts[2] === 'collections' && parts.length === 3) {
        const input = await body(request)
        const context = userContext(input, request)
        json(response, 201, { collection: await options.service.createCollection(context, { name: input.name, slug: input.slug, description: input.description }) })
        return
      }
      if (request.method === 'DELETE' && parts[2] === 'collections' && parts.length === 4) {
        const input = await body(request)
        const context = userContext(input, request)
        await options.service.deleteCollection(context, parts[3])
        response.statusCode = 204
        response.end()
        return
      }
      if (request.method === 'GET' && parts[2] === 'documents' && parts.length === 3) {
        const context = { ...workspaceFromUrl(url), embedding: embeddingFromHeader(request) }
        const collectionId = url.searchParams.get('collectionId') || undefined
        json(response, 200, { documents: await options.service.listDocuments(context, collectionId) })
        return
      }
      if (request.method === 'GET' && parts[2] === 'documents' && parts.length === 4) {
        const context = { ...workspaceFromUrl(url), embedding: embeddingFromHeader(request) }
        json(response, 200, await options.service.getDocument(context, parts[3]))
        return
      }
      if (request.method === 'POST' && parts[2] === 'documents' && parts.length === 3) {
        const input = await body(request)
        const context = userContext(input, request)
        const content = input.content
        const title = input.title
        if (typeof content !== 'string' || typeof title !== 'string') throw new KnowledgeError('INVALID_BODY', 'title and content are required')
        json(response, 202, { ...(await options.service.ingestDocument(context, {
          workspaceId: context.workspaceId!, userId: context.userId, collectionId: stringField(input, 'collectionId'),
          title, content, sourceType: input.sourceType as never, sourceUri: typeof input.sourceUri === 'string' ? input.sourceUri : undefined,
          mimeType: typeof input.mimeType === 'string' ? input.mimeType : undefined, metadata: input.metadata as Record<string, unknown> | undefined,
        })) })
        return
      }
      if (request.method === 'DELETE' && parts[2] === 'documents' && parts.length === 4) {
        const input = await body(request)
        const context = userContext(input, request)
        json(response, 202, { job: await options.service.deleteDocument(context, parts[3]) })
        return
      }
      if (request.method === 'POST' && parts[2] === 'search' && parts.length === 3) {
        const input = await body(request)
        const context = userContext(input, request)
        const query = stringField(input, 'query')
        const limit = input.limit === undefined ? 10 : Number(input.limit)
        json(response, 200, { results: await options.service.search(context, stringField(input, 'collectionId'), query, limit) })
        return
      }
      if (request.method === 'GET' && parts[2] === 'jobs' && parts.length === 4) {
        const context = { userId: stringField({ userId: url.searchParams.get('userId') }, 'userId') }
        json(response, 200, { job: await options.service.getJob(context, parts[3]) })
        return
      }
      if (request.method === 'POST' && parts[2] === 'backends' && parts[3] && parts[4] === 'distributed' && parts[5] === 'deploy') {
        const input = await body(request)
        const context = userContext(input, request)
        if (parts[3] !== context.workspaceId) throw new KnowledgeError('AUTH_DENIED', 'Deployment workspace does not match the request path', { status: 403 })
        const port = Number(input.port ?? 22)
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new KnowledgeError('INVALID_BODY', 'SSH port is invalid')
        const privateKey = stringField(input, 'privateKey')
        if (!privateKey.includes('PRIVATE KEY')) throw new KnowledgeError('INVALID_BODY', 'privateKey is invalid')
        json(response, 202, { job: await options.service.requestDistributedDeployment({
          ...context, host: stringField(input, 'host'), port, user: stringField(input, 'user'), remoteRoot: stringField(input, 'remoteRoot'), knownHosts: stringField(input, 'knownHosts'), privateKey,
          endpoint: stringField(input, 'endpoint'),
          zeroToken: typeof input.zeroToken === 'string' ? input.zeroToken : undefined,
          chartReference: typeof input.chartReference === 'string' ? input.chartReference : undefined,
          namespace: typeof input.namespace === 'string' ? input.namespace : undefined, releaseName: typeof input.releaseName === 'string' ? input.releaseName : undefined,
        }) })
        return
      }
      throw new KnowledgeError('NOT_FOUND', 'Knowledge endpoint was not found', { status: 404 })
    } catch (error) {
      const known = error instanceof KnowledgeError ? error : new KnowledgeError('INTERNAL_ERROR', safeErrorMessage(error), { status: 500, retryable: true })
      if (known.status >= 500) console.error(`Knowledge Service request failed: ${known.message}`)
      json(response, known.status, { error: { code: known.code, message: known.message, retryable: known.retryable } })
    }
  })
  return server
}

function embeddingFromHeader(request: IncomingMessage | undefined) {
  const header = request?.headers['x-openlink-embedding']
  const encoded = Array.isArray(header) ? header[0] : header
  if (!encoded) return undefined
  try { return embeddingContext({ embedding: JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) }) } catch { throw new KnowledgeError('INVALID_BODY', 'embedding is invalid') }
}
