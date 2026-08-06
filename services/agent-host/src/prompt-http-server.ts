import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import type { AgentNativeSessionSnapshot, AgentProviderRuntimeConfiguration } from './contracts.js'
import { AgentHostError } from './errors.js'
import { isProjectId, type ProjectVmManager } from './project-vm.js'

export interface PromptRuntimeSession {
  prompt(message: string, signal?: AbortSignal): Promise<Response>
  cleanup(): Promise<void>
}

export interface PromptRuntimeBackend {
  createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration?: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string): Promise<PromptRuntimeSession>
  close(): Promise<void>
}

export interface PromptHttpServerConfig {
  host: string
  port: number
  apiToken: string
  storageRoot: string
  transport: string
  sessionIdleTtlMs: number
  maxSessions?: number
  projectVmManager?: ProjectVmManager
}

interface PromptBody {
  userId: string
  workspaceId: string
  projectId?: string
  message: string
  runtimeConfiguration?: AgentProviderRuntimeConfiguration
  nativeSession?: AgentNativeSessionSnapshot
}

interface SessionEntry {
  runtime: PromptRuntimeSession
  lastUsedAt: number
  busy: boolean
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024 * 1024) throw new AgentHostError('INVALID_BODY', 'Request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new AgentHostError('INVALID_BODY', 'Request body is invalid JSON')
  }
}

function parsePromptBody(value: unknown): PromptBody {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Request body is invalid')
  const body = value as Record<string, unknown>
  const userId = typeof body.userId === 'string' ? body.userId : ''
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  const projectId = body.projectId === undefined ? undefined : typeof body.projectId === 'string' ? body.projectId : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(userId)) throw new AgentHostError('INVALID_BODY', 'userId is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new AgentHostError('INVALID_BODY', 'workspaceId is invalid')
  if (projectId !== undefined && !isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  if (!message || message.length > 10_000) throw new AgentHostError('INVALID_BODY', 'message is invalid')
  const runtimeConfiguration = body.runtimeConfiguration === undefined
    ? undefined
    : parseRuntimeConfiguration(body.runtimeConfiguration)
  const nativeSession = body.nativeSession === undefined ? undefined : parseNativeSession(body.nativeSession)
  return { userId, workspaceId, projectId, message, runtimeConfiguration, nativeSession }
}

function parseNativeSession(value: unknown): AgentNativeSessionSnapshot {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'nativeSession is invalid')
  const snapshot = value as Record<string, unknown>
  const header = snapshot.header
  const entries = snapshot.entries
  if (!header || typeof header !== 'object' || (header as Record<string, unknown>).type !== 'session' || typeof (header as Record<string, unknown>).id !== 'string') {
    throw new AgentHostError('INVALID_BODY', 'nativeSession header is invalid')
  }
  if (!Array.isArray(entries) || entries.length > 50_000 || entries.some((entry) => {
    if (!entry || typeof entry !== 'object') return true
    const item = entry as Record<string, unknown>
    return typeof item.id !== 'string' || typeof item.type !== 'string' || typeof item.timestamp !== 'string'
  })) throw new AgentHostError('INVALID_BODY', 'nativeSession entries are invalid')
  return { header: header as Record<string, unknown>, entries: entries as Array<Record<string, unknown>> }
}

function parseRuntimeConfiguration(value: unknown): AgentProviderRuntimeConfiguration {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'runtimeConfiguration is invalid')
  const input = value as Record<string, unknown>
  const providerId = typeof input.providerId === 'string' ? input.providerId : ''
  const modelId = typeof input.modelId === 'string' ? input.modelId : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey : ''
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : ''
  const revision = typeof input.revision === 'string' ? input.revision : ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(providerId) || providerId.length > 96) throw new AgentHostError('INVALID_BODY', 'providerId is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(modelId)) throw new AgentHostError('INVALID_BODY', 'modelId is invalid')
  if (!apiKey || apiKey.length > 8_192 || /[\r\n\u0000]/.test(apiKey)) throw new AgentHostError('INVALID_BODY', 'provider credential is invalid')
  let endpoint: URL
  try { endpoint = new URL(baseUrl) } catch { throw new AgentHostError('INVALID_BODY', 'provider baseUrl is invalid') }
  const allowInsecureEndpoint = process.env.OPENLINK_ALLOW_INSECURE_PROVIDER_ENDPOINTS === '1'
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const localName = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')
  const unsafeIp = isIP(hostname) !== 0 && isUnsafeLiteralIp(hostname)
  if ((!allowInsecureEndpoint && endpoint.protocol !== 'https:') || !['https:', 'http:'].includes(endpoint.protocol) || !hostname || endpoint.username || endpoint.password || localName || unsafeIp || baseUrl.length > 2_048) {
    throw new AgentHostError('INVALID_BODY', 'provider baseUrl is invalid')
  }
  if (!revision || revision.length > 80 || /[\r\n\u0000]/.test(revision)) throw new AgentHostError('INVALID_BODY', 'provider revision is invalid')
  return { providerId, modelId, apiKey, baseUrl: endpoint.toString().replace(/\/$/, ''), revision }
}

function isUnsafeLiteralIp(hostname: string): boolean {
  if (hostname === '::' || hostname === '::1') return true
  const lower = hostname.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
  if (lower.startsWith('::ffff:')) return isUnsafeLiteralIp(lower.slice(7))
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

function parseProviderCheckBody(value: unknown) {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Request body is invalid')
  const body = value as Record<string, unknown>
  const userId = typeof body.userId === 'string' ? body.userId : ''
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(userId)) throw new AgentHostError('INVALID_BODY', 'userId is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new AgentHostError('INVALID_BODY', 'workspaceId is invalid')
  return { userId, workspaceId, runtimeConfiguration: parseRuntimeConfiguration(body.runtimeConfiguration) }
}

function json(response: import('node:http').ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(payload))
}

async function pipeResponse(
  upstream: Response,
  response: import('node:http').ServerResponse,
  transport: string,
): Promise<void> {
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    throw new AgentHostError('PI_PROMPT_FAILED', detail || `Agent Worker returned ${upstream.status}`)
  }
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'X-OpenLink-Agent-Transport': transport,
  })
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(value)
    }
    response.end()
  } finally {
    reader.releaseLock()
  }
}

export async function startPromptHttpServer(
  config: PromptHttpServerConfig,
  backend: PromptRuntimeBackend,
): Promise<{ server: Server; shutdown(): Promise<void> }> {
  await mkdir(config.storageRoot, { recursive: true, mode: 0o700 })
  const sessions = new Map<string, SessionEntry>()

  async function handlePrompt(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new AgentHostError('INVALID_SESSION', 'sessionId is invalid')
    const body = parsePromptBody(await readJson(request))
    if (!body.projectId) throw new AgentHostError('INVALID_BODY', 'projectId is required for agent sessions')
    if (config.projectVmManager) await config.projectVmManager.ensure(body.projectId)
    const baseKey = `${body.userId}:${body.workspaceId}:${sessionId}`
    const runtimeIdentity = body.runtimeConfiguration
      ? `${body.runtimeConfiguration.providerId}/${body.runtimeConfiguration.modelId}@${body.runtimeConfiguration.revision}`
      : 'host-default'
    const key = `${baseKey}:${runtimeIdentity}`
    let entry = sessions.get(key)
    if (!entry) {
      if (config.maxSessions !== undefined && sessions.size >= config.maxSessions) {
        throw new AgentHostError('SESSION_BUSY', 'This runtime has reached its concurrent session limit', { retryable: true })
      }
      for (const [existingKey, existing] of sessions) {
        if (!existingKey.startsWith(`${baseKey}:`)) continue
        if (existing.busy) throw new AgentHostError('SESSION_BUSY', 'Agent session is changing model while a prompt is active', { retryable: true })
        sessions.delete(existingKey)
        await existing.runtime.cleanup()
      }
      entry = { runtime: await backend.createSession(body.userId, body.workspaceId, sessionId, body.runtimeConfiguration, body.nativeSession, body.projectId), lastUsedAt: Date.now(), busy: false }
      sessions.set(key, entry)
    }
    if (entry.busy) throw new AgentHostError('SESSION_BUSY', 'Agent session is already processing a prompt', { retryable: true })
    entry.busy = true
    entry.lastUsedAt = Date.now()
    const abortController = new AbortController()
    response.once('close', () => { if (!response.writableEnded) abortController.abort() })
    try {
      await pipeResponse(await entry.runtime.prompt(body.message, abortController.signal), response, config.transport)
    } finally {
      entry.busy = false
      entry.lastUsedAt = Date.now()
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, { ok: true, runtime: config.transport, sessions: sessions.size })
        return
      }
      if (!authorized(request, config.apiToken)) throw new AgentHostError('AUTH_DENIED', 'Agent Host authorization is invalid')
      if (request.method === 'POST' && url.pathname === '/v1/providers/check') {
        const body = parseProviderCheckBody(await readJson(request))
        const sessionId = `provider-check-${randomBytes(8).toString('hex')}`
        const runtime = await backend.createSession(body.userId, body.workspaceId, sessionId, body.runtimeConfiguration)
        try {
          const upstream = await runtime.prompt('Reply with exactly the word OK.', AbortSignal.timeout(90_000))
          if (!upstream.ok || !upstream.body) throw new AgentHostError('PI_PROMPT_FAILED', 'Provider check request failed')
          const output = await upstream.text()
          if (/"type"\s*:\s*"extension_error"/.test(output) || /"stopReason"\s*:\s*"error"/.test(output)) {
            throw new AgentHostError('PI_PROMPT_FAILED', 'The model provider rejected the connectivity check')
          }
          json(response, 200, { ok: true, providerId: body.runtimeConfiguration.providerId, modelId: body.runtimeConfiguration.modelId })
        } finally {
          await runtime.cleanup()
        }
        return
      }
      const match = /^\/v1\/agent\/sessions\/([^/]+)\/events$/.exec(url.pathname)
      if (request.method === 'POST' && match) {
        await handlePrompt(request, response, decodeURIComponent(match[1]!))
        return
      }
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Route was not found' } })
    })().catch((error) => {
      if (response.headersSent) {
        if (!response.writableEnded) response.end()
        return
      }
      const failure = error instanceof AgentHostError
        ? error
        : new AgentHostError('PROVISIONING_FAILED', error instanceof Error ? error.message : String(error))
      const status = failure.code === 'AUTH_DENIED' ? 403 : failure.code === 'SESSION_BUSY' ? 409 : 400
      json(response, status, { error: { code: failure.code, message: failure.message, retryable: failure.retryable } })
    })
  })

  const reaper = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleTtlMs
    for (const [key, entry] of sessions) {
      if (entry.busy || entry.lastUsedAt >= cutoff) continue
      sessions.delete(key)
      void entry.runtime.cleanup()
    }
  }, 60_000)
  reaper.unref()

  const shutdown = async (): Promise<void> => {
    clearInterval(reaper)
    await Promise.allSettled([...sessions.values()].map((entry) => entry.runtime.cleanup()))
    sessions.clear()
    await backend.close()
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(config.port, config.host, () => {
      server.removeListener('error', rejectListen)
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : config.port
      process.stdout.write(`OpenLink Agent Host (${config.transport}) listening on http://${config.host}:${port}\n`)
      resolveListen()
    })
  })
  return { server, shutdown }
}
