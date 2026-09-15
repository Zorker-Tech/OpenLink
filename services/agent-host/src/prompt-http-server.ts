import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isIP } from 'node:net'
import type { AgentExtensionUiResponse, AgentNativeSessionSnapshot, AgentProviderRuntimeConfiguration } from './contracts.js'
import { AgentHostError } from './errors.js'
import { isProjectId, type ProjectVmManager } from './project-vm.js'
import type { ProjectRuntimeDescriptor, ProjectSupabaseManagementRequest, ProjectSupabaseStudioProxyRequest } from './project-runtime.js'
import type { ProjectRuntimeController } from './project-runtime-router.js'
import { BrowserHostClient, type BrowserAgentSession } from './browser-client.js'
import { BrowserGateway } from './browser-gateway.js'
import { CodeServerGateway } from './code-server-gateway.js'
import { approveSupabaseMcpConfirmation, handleSupabaseMcpRequest, listPendingSupabaseMcpConfirmations } from './supabase-mcp.js'

export interface PromptRuntimeSession {
  control?(input: { action: string; text?: string }): Promise<unknown>
  prompt(message: string, signal?: AbortSignal, attachments?: PromptAttachment[]): Promise<Response>
  /** Pause an idle Worker while retaining its sandbox state for fast resume. */
  pause?(): Promise<void>
  /** Resume a paused Worker before serving a prompt or lease warmup. */
  resume?(): Promise<void>
  /** Apply an approved outbound-network grant to this live sandbox. */
  networkAccess?(hosts: string[], mode: 'temporary' | 'persistent', durationSeconds?: number): Promise<void>
  /** Resolve a pending Pi extension UI request (confirm/select/input/editor). */
  resolveExtensionUi?(response: AgentExtensionUiResponse): Promise<void>
  /** Read display-safe capabilities from the already provisioned worker. */
  resources?(request?: AgentResourceRequest): Promise<unknown>
  /** Hot-swap the optional Browser capability without recreating the Agent. */
  setBrowser?(browser?: BrowserAgentSession): Promise<void>
  cleanup(): Promise<void>
}

export type PromptAttachment = {
  type: 'image'; mediaType: string; url: string; filename?: string
} | {
  type: 'text'; mediaType: 'text/plain'; text: string; filename?: string
} | {
  type: 'reference'; referenceType: 'file' | 'thread'; name: string; path: string
} | {
  type: 'file'; uploadId: string; batchId: string; mediaType: string; filename: string
  relativePath?: string; sizeBytes: number; sha256: string; contentBase64: string
}

export interface AgentResourceRequest {
  scope?: 'command' | 'mention' | 'skill' | 'title'
  command?: string
  query?: string
}

export interface PromptRuntimeAgentOptions {
  agent?: 'pi' | 'codex'
  accessMode?: 'restricted' | 'ask' | 'open'
}

export interface PromptRuntimeBackend {
  createSession(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor, browser?: BrowserAgentSession, agentOptions?: PromptRuntimeAgentOptions): Promise<PromptRuntimeSession>
  /** Reattach a still-running durable workload after Agent Host restarts. */
  recoverSession?(userId: string, workspaceId: string, sessionId: string, runtimeConfiguration: AgentProviderRuntimeConfiguration, nativeSession?: AgentNativeSessionSnapshot, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor, browser?: BrowserAgentSession, agentOptions?: PromptRuntimeAgentOptions): Promise<PromptRuntimeSession | null>
  /** Remove a durable Project VM workload left by a previous Agent Host process. */
  cleanupSession?(userId: string, workspaceId: string, sessionId: string, projectId?: string, projectRuntime?: ProjectRuntimeDescriptor): Promise<void>
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
  projectRuntimeManager?: ProjectRuntimeController
  requireProjectRuntime?: boolean
  /** Resolves a chat session's authoritative Supabase access mode. */
  resolveSupabaseAccessMode?: (sessionId: string) => Promise<import('./access-firewall.js').AccessMode>
  /** Public URL used by browser clients; must not be a Project VM loopback URL. */
  browserGatewayPublicUrl?: string
  browserGatewayAllowedOrigins?: string[]
  browserGatewayUpstreamOrigin?: string
  /** Keep durable Agent workloads alive while the coordinating Host process restarts. */
  preserveSessionsOnShutdown?: boolean
  /** Invalidates the host-derived Codex plugin snapshot after installation. */
  invalidateCodexPluginSnapshot?: () => void
}

interface PromptBody {
  userId: string
  workspaceId: string
  projectId?: string
  message: string
  attachments: PromptAttachment[]
  runtimeConfiguration: AgentProviderRuntimeConfiguration
  nativeSession?: AgentNativeSessionSnapshot
  browserSessionId?: string
  /** Session-bound agent kind; selects the worker runtime. */
  agent?: 'pi' | 'codex'
  /** Session access mode; maps to codex sandbox/approval flags. */
  accessMode?: 'restricted' | 'ask' | 'open'
}

function parsePromptAttachments(value: unknown): PromptAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 24) throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
  let encodedImageBytes = 0
  let textBytes = 0
  let imageCount = 0
  let textCount = 0
  let referenceCount = 0
  let fileCount = 0
  let encodedFileBytes = 0
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
    const item = candidate as Record<string, unknown>
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType.toLowerCase() : ''
    const filename = typeof item.filename === 'string' ? item.filename.trim().slice(0, 240) : undefined
    if (item.type === 'file') {
      const uploadId = typeof item.uploadId === 'string' ? item.uploadId : ''
      const batchId = typeof item.batchId === 'string' ? item.batchId : ''
      const relativePath = typeof item.relativePath === 'string' ? item.relativePath : undefined
      const sizeBytes = typeof item.sizeBytes === 'number' ? item.sizeBytes : -1
      const sha256 = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : ''
      const contentBase64 = typeof item.contentBase64 === 'string' ? item.contentBase64 : ''
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      const safeFilename = Boolean(filename && filename !== '.' && filename !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(filename))
      const safeRelativePath = relativePath === undefined || (relativePath.length <= 1024
        && !relativePath.startsWith('/') && !relativePath.includes('\\') && !relativePath.includes('//')
        && !/[\u0000-\u001f\u007f]/.test(relativePath)
        && relativePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..'))
      fileCount += 1
      encodedFileBytes += contentBase64.length
      if (!uuid.test(uploadId) || !uuid.test(batchId) || !safeFilename || !safeRelativePath
        || !mediaType || mediaType.length > 160 || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 2 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(sha256) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)
        || fileCount > 16 || encodedFileBytes + encodedImageBytes > 12_000_000) throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
      const content = Buffer.from(contentBase64, 'base64')
      if (content.byteLength !== sizeBytes || createHash('sha256').update(content).digest('hex') !== sha256) throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
      return { type: 'file' as const, uploadId, batchId, mediaType, filename: filename!, ...(relativePath ? { relativePath } : {}), sizeBytes, sha256, contentBase64 }
    }
    if (item.type === 'reference') {
      const referenceType: 'file' | 'thread' | '' = item.referenceType === 'file' || item.referenceType === 'thread' ? item.referenceType : ''
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : ''
      const path = typeof item.path === 'string' ? item.path : ''
      referenceCount += 1
      if (!referenceType || !name || referenceCount > 16 || path.length > 1024 || path.includes('\0')
        || (referenceType === 'thread' && !/^thread:\/\/[A-Za-z0-9_-]{1,64}$/.test(path))
        || (referenceType === 'file' && (!path || /^\w+:\/\//.test(path)))) throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
      return { type: 'reference' as const, referenceType, name, path }
    }
    if (item.type === 'text') {
      const text = typeof item.text === 'string' ? item.text : ''
      const bytes = Buffer.byteLength(text, 'utf8')
      textCount += 1
      textBytes += bytes
      if (mediaType !== 'text/plain' || !text || textCount > 4 || bytes > 256 * 1024 || textBytes > 512 * 1024) throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
      return { type: 'text' as const, mediaType: 'text/plain' as const, text, ...(filename ? { filename } : {}) }
    }
    const url = typeof item.url === 'string' ? item.url : ''
    imageCount += 1
    if (item.type !== 'image' || imageCount > 4 || !/^image\/(?:png|jpeg|webp|gif)$/.test(mediaType) || !url.startsWith(`data:${mediaType};base64,`) || url.length > 3_000_000) {
      throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
    }
    encodedImageBytes += url.length
    if (encodedImageBytes + encodedFileBytes > 12_000_000) throw new AgentHostError('INVALID_BODY', 'attachments are invalid')
    return { type: 'image' as const, mediaType, url, ...(filename ? { filename } : {}) }
  })
}

interface PreparedSessionRequest {
  userId: string
  workspaceId: string
  sessionId: string
  projectId: string
  runtimeConfiguration: AgentProviderRuntimeConfiguration
  nativeSession?: AgentNativeSessionSnapshot
  browser?: BrowserAgentSession
  browserSessionId?: string
  projectRuntime?: ProjectRuntimeDescriptor
  agent?: 'pi' | 'codex'
  accessMode?: 'restricted' | 'ask' | 'open'
  baseKey: string
  key: string
}

interface NetworkAccessBody {
  userId: string
  workspaceId: string
  hosts: string[]
  mode: 'temporary' | 'persistent'
  durationSeconds?: number
}

function parseProjectSupabaseManagementBody(value: unknown): ProjectSupabaseManagementRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentHostError('INVALID_BODY', 'management body is invalid')
  const body = value as Record<string, unknown>
  const operations = new Set<ProjectSupabaseManagementRequest['operation']>(['tables', 'database', 'query', 'auth-users', 'storage-buckets', 'functions', 'realtime', 'services', 'logs'])
  if (typeof body.operation !== 'string' || !operations.has(body.operation as ProjectSupabaseManagementRequest['operation'])) throw new AgentHostError('INVALID_BODY', 'management operation is invalid')
  if (body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 12_000)) throw new AgentHostError('INVALID_BODY', 'management query is invalid')
  if (body.service !== undefined && (typeof body.service !== 'string' || !/^[a-z0-9-]{1,63}$/.test(body.service))) throw new AgentHostError('INVALID_BODY', 'management service is invalid')
  return {
    operation: body.operation as ProjectSupabaseManagementRequest['operation'],
    ...(body.query !== undefined ? { query: body.query } : {}),
    ...(body.service !== undefined ? { service: body.service } : {}),
  }
}

function parseProjectSupabaseStudioProxyBody(value: unknown): ProjectSupabaseStudioProxyRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentHostError('INVALID_BODY', 'Studio proxy body is invalid')
  const body = value as Record<string, unknown>
  const methods = new Set<ProjectSupabaseStudioProxyRequest['method']>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
  if (typeof body.method !== 'string' || !methods.has(body.method as ProjectSupabaseStudioProxyRequest['method'])) throw new AgentHostError('INVALID_BODY', 'Studio proxy method is invalid')
  if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.length > 12_000 || /[\u0000-\u001f\\]/.test(body.path)) throw new AgentHostError('INVALID_BODY', 'Studio proxy path is invalid')
  if (body.bodyBase64 !== undefined && (typeof body.bodyBase64 !== 'string' || body.bodyBase64.length > 5_600_000 || !/^[A-Za-z0-9_-]*$/.test(body.bodyBase64))) throw new AgentHostError('INVALID_BODY', 'Studio proxy body is invalid')
  const headers: Record<string, string> = {}
  if (body.headers !== undefined) {
    if (!body.headers || typeof body.headers !== 'object' || Array.isArray(body.headers)) throw new AgentHostError('INVALID_BODY', 'Studio proxy headers are invalid')
    for (const [name, candidate] of Object.entries(body.headers)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/i.test(name) || typeof candidate !== 'string' || candidate.length > 4_096 || /[\r\n\u0000]/.test(candidate)) throw new AgentHostError('INVALID_BODY', 'Studio proxy header is invalid')
      headers[name.toLowerCase()] = candidate
    }
  }
  return {
    method: body.method as ProjectSupabaseStudioProxyRequest['method'],
    path: body.path,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(body.bodyBase64 ? { bodyBase64: body.bodyBase64 } : {}),
  }
}

interface SessionEntry {
  runtime: PromptRuntimeSession
  lastUsedAt: number
  busy: boolean
  recovering?: boolean
  paused?: boolean
  userPaused?: boolean
  browserSessionId?: string
}

function isMissingSandboxFailure(error: unknown): boolean {
  if (!(error instanceof AgentHostError)) return false
  return /(?:DOCKER::)?SANDBOX_NOT_FOUND|sandbox\s+(?:was\s+)?not found/i.test(error.message)
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
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
  const attachments = parsePromptAttachments(body.attachments)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(userId)) throw new AgentHostError('INVALID_BODY', 'userId is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new AgentHostError('INVALID_BODY', 'workspaceId is invalid')
  if (projectId !== undefined && !isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  if ((!message && !attachments.length) || message.length > 10_000) throw new AgentHostError('INVALID_BODY', 'message is invalid')
  const runtimeConfiguration = parseRuntimeConfiguration(body.runtimeConfiguration)
  const nativeSession = body.nativeSession === undefined ? undefined : parseNativeSession(body.nativeSession)
  const browserSessionId = body.browserSessionId === undefined
    ? undefined
    : typeof body.browserSessionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(body.browserSessionId)
      ? body.browserSessionId
      : ''
  if (body.browserSessionId !== undefined && !browserSessionId) throw new AgentHostError('INVALID_BODY', 'browserSessionId is invalid')
  const agent: 'pi' | 'codex' | undefined = body.agent === 'codex' || body.agent === 'pi' ? body.agent : undefined
  const accessMode: 'restricted' | 'ask' | 'open' | undefined = body.accessMode === 'restricted' || body.accessMode === 'ask' || body.accessMode === 'open'
    ? body.accessMode
    : undefined
  return { userId, workspaceId, projectId, message, attachments, runtimeConfiguration, nativeSession, browserSessionId, agent, accessMode }
}

function parseNetworkAccessBody(value: unknown): NetworkAccessBody {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Network access request is invalid')
  const body = value as Record<string, unknown>
  const userId = typeof body.userId === 'string' ? body.userId : ''
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(userId)) throw new AgentHostError('INVALID_BODY', 'userId is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new AgentHostError('INVALID_BODY', 'workspaceId is invalid')
  if (!Array.isArray(body.hosts) || body.hosts.length === 0 || body.hosts.length > 32) throw new AgentHostError('INVALID_BODY', 'hosts must contain 1-32 domains')
  const hosts = body.hosts.map((value) => typeof value === 'string' ? value.trim().toLowerCase() : '')
  if (hosts.some((host) => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || host.includes('..'))) {
    throw new AgentHostError('INVALID_BODY', 'hosts contains an invalid domain')
  }
  const mode = body.mode === 'persistent' || body.mode === 'temporary' ? body.mode : ''
  if (!mode) throw new AgentHostError('INVALID_BODY', 'mode must be temporary or persistent')
  const durationSeconds = body.durationSeconds === undefined ? 900 : Number(body.durationSeconds)
  if (mode === 'temporary' && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3_600)) {
    throw new AgentHostError('INVALID_BODY', 'temporary network access duration must be 1-3600 seconds')
  }
  return { userId, workspaceId, hosts: [...new Set(hosts)], mode, ...(mode === 'temporary' ? { durationSeconds } : {}) }
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
  if (apiKey.length > 8_192 || /[\r\n\u0000]/.test(apiKey)) throw new AgentHostError('INVALID_BODY', 'provider credential is invalid')
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
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = parseIpv4(value)
  if (ipv4) return isUnsafeIpv4(ipv4)
  if (isIP(value) !== 6) return false

  // URL normalisation turns IPv4-mapped IPv6 literals into hexadecimal form
  // (for example ::ffff:127.0.0.1 becomes ::ffff:7f00:1). Parse the address
  // instead of relying on string prefixes so equivalent spellings cannot
  // bypass the private/loopback checks.
  const hextets = parseIpv6(value)
  if (!hextets) return true
  const first = hextets[0]!
  const isUnspecified = hextets.every((part) => part === 0)
  const isLoopback = isUnspecified === false && hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1
  const isUniqueLocal = (first & 0xfe00) === 0xfc00
  const isLinkLocal = (first & 0xffc0) === 0xfe80
  const isMulticast = (first & 0xff00) === 0xff00
  const mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff
  if (mapped) {
    return isUnsafeIpv4([
      (hextets[6]! >>> 8) & 0xff,
      hextets[6]! & 0xff,
      (hextets[7]! >>> 8) & 0xff,
      hextets[7]! & 0xff,
    ])
  }

  // Reject unspecified, loopback, ULA, link-local and multicast addresses.
  // Also reject IPv4-compatible literals (::/96) conservatively: they are
  // deprecated and can otherwise encode a private IPv4 endpoint in an IPv6
  // spelling that is easy to miss during review.
  const ipv4Compatible = hextets.slice(0, 6).every((part) => part === 0)
  return isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast || ipv4Compatible
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null
  const parsed = parts.map(Number)
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return parsed as [number, number, number, number]
}

function isUnsafeIpv4([a, b]: [number, number, number, number]): boolean {
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function parseIpv6(value: string): number[] | null {
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    if (lastColon < 0) return null
    const mapped = parseIpv4(value.slice(lastColon + 1))
    if (!mapped) return null
    value = `${value.slice(0, lastColon)}:${((mapped[0]! << 8) | mapped[1]!).toString(16)}:${((mapped[2]! << 8) | mapped[3]!).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  if (halves.length === 1 && left.length !== 8) return null
  if (halves.length === 2 && left.length + right.length >= 8) return null
  const missing = 8 - left.length - right.length
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ]
}

function parseProviderCheckBody(value: unknown) {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Request body is invalid')
  const body = value as Record<string, unknown>
  const userId = typeof body.userId === 'string' ? body.userId : ''
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(userId)) throw new AgentHostError('INVALID_BODY', 'userId is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new AgentHostError('INVALID_BODY', 'workspaceId is invalid')
  if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  return { userId, workspaceId, projectId, runtimeConfiguration: parseRuntimeConfiguration(body.runtimeConfiguration) }
}

function safeIdentity(value: unknown, label: string): string {
  const result = typeof value === 'string' ? value : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new AgentHostError('INVALID_BODY', `${label} is invalid`)
  return result
}

function parseBrowserSessionBody(value: unknown) {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Browser session body is invalid')
  const body = value as Record<string, unknown>
  const ownerId = safeIdentity(body.ownerId, 'ownerId')
  const workspaceId = safeIdentity(body.workspaceId, 'workspaceId')
  const profileKey = body.profileKey === undefined ? undefined : safeIdentity(body.profileKey, 'profileKey')
  const surface = body.surface === 'native-preview' || body.surface === 'chromium-stream' ? body.surface : null
  if (!surface) throw new AgentHostError('INVALID_BODY', 'Browser surface is invalid')
  if (body.viewport !== undefined && (!body.viewport || typeof body.viewport !== 'object')) throw new AgentHostError('INVALID_BODY', 'Browser viewport is invalid')
  if (surface === 'native-preview' && (!body.preview || typeof body.preview !== 'object')) throw new AgentHostError('INVALID_BODY', 'Preview configuration is required')
  if (surface === 'chromium-stream' && body.chromium !== undefined && (!body.chromium || typeof body.chromium !== 'object')) throw new AgentHostError('INVALID_BODY', 'Chromium configuration is invalid')
  return {
    ownerId,
    workspaceId,
    profileKey,
    surface: surface as 'native-preview' | 'chromium-stream',
    viewport: body.viewport,
    preview: body.preview,
    chromium: body.chromium,
  }
}

function parseBrowserDeleteBody(value: unknown) {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Browser delete body is invalid')
  const body = value as Record<string, unknown>
  return {
    ownerId: safeIdentity(body.ownerId, 'ownerId'),
    workspaceId: safeIdentity(body.workspaceId, 'workspaceId'),
  }
}

function parseCodeServerSessionBody(value: unknown) {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Code-server session body is invalid')
  const body = value as Record<string, unknown>
  return {
    ownerId: safeIdentity(body.ownerId, 'ownerId'),
    workspaceId: safeIdentity(body.workspaceId, 'workspaceId'),
  }
}

function parseGitCheckoutBody(value: unknown): { ref: string } {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Git checkout body is invalid')
  const body = value as Record<string, unknown>
  const ref = typeof body.ref === 'string'
    ? body.ref.trim()
    : ''
  if (ref !== 'latest' && !/^[0-9a-f]{7,40}$/i.test(ref)) throw new AgentHostError('GIT_REF_INVALID', 'Git version reference is invalid')
  return { ref }
}

function parseLeaseBody(value: unknown) {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Lease body is invalid')
  const body = value as Record<string, unknown>
  const userId = safeIdentity(body.userId, 'userId')
  const workspaceId = safeIdentity(body.workspaceId, 'workspaceId')
  const sessionId = safeIdentity(body.sessionId, 'sessionId')
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  const runtimeConfiguration = body.runtimeConfiguration === undefined
    ? undefined
    : parseRuntimeConfiguration(body.runtimeConfiguration)
  const nativeSession = body.nativeSession === undefined ? undefined : parseNativeSession(body.nativeSession)
  const browserSessionId = body.browserSessionId === undefined
    ? undefined
    : typeof body.browserSessionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(body.browserSessionId)
      ? body.browserSessionId
      : ''
  if (body.browserSessionId !== undefined && !browserSessionId) throw new AgentHostError('INVALID_BODY', 'browserSessionId is invalid')
  const agent: 'pi' | 'codex' | undefined = body.agent === 'codex' || body.agent === 'pi' ? body.agent : undefined
  if (body.agent !== undefined && !agent) throw new AgentHostError('INVALID_BODY', 'agent is invalid')
  const accessMode: 'restricted' | 'ask' | 'open' | undefined = body.accessMode === 'restricted' || body.accessMode === 'ask' || body.accessMode === 'open'
    ? body.accessMode
    : undefined
  if (body.accessMode !== undefined && !accessMode) throw new AgentHostError('INVALID_BODY', 'accessMode is invalid')
  return { userId, workspaceId, sessionId, projectId, runtimeConfiguration, nativeSession, browserSessionId, agent, accessMode }
}

function parseExtensionUiResponse(value: unknown): AgentExtensionUiResponse {
  if (!value || typeof value !== 'object') throw new AgentHostError('INVALID_BODY', 'Extension UI response is invalid')
  const body = value as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new AgentHostError('INVALID_BODY', 'Extension UI response id is invalid')
  const confirmed = body.confirmed
  const valueText = body.value
  const cancelled = body.cancelled
  if (confirmed !== undefined && typeof confirmed !== 'boolean') throw new AgentHostError('INVALID_BODY', 'Extension UI confirmation is invalid')
  if (valueText !== undefined && (typeof valueText !== 'string' || valueText.length > 100_000)) throw new AgentHostError('INVALID_BODY', 'Extension UI value is invalid')
  if (cancelled !== undefined && cancelled !== true) throw new AgentHostError('INVALID_BODY', 'Extension UI cancellation is invalid')
  if (cancelled === true && (confirmed !== undefined || valueText !== undefined)) throw new AgentHostError('INVALID_BODY', 'Extension UI response is ambiguous')
  if (confirmed === undefined && valueText === undefined && cancelled !== true) throw new AgentHostError('INVALID_BODY', 'Extension UI response has no value')
  if (confirmed !== undefined && valueText !== undefined) throw new AgentHostError('INVALID_BODY', 'Extension UI response is ambiguous')
  return {
    id,
    ...(confirmed !== undefined ? { confirmed } : {}),
    ...(valueText !== undefined ? { value: valueText } : {}),
    ...(cancelled === true ? { cancelled: true } : {}),
  }
}

function json(response: import('node:http').ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(payload))
}

function providerCheckFailureDetail(output: string, credential: string): string | null {
  // Pi's NDJSON stream carries provider failures on the terminal assistant
  // message. Preserve a bounded, credential-scrubbed diagnostic so the
  // settings UI can distinguish a bad key/model from a provider-side issue
  // such as exhausted billing. Do not pass arbitrary stream payloads through
  // unchanged: some providers echo request headers in their error bodies.
  let detail: string | null = null
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    try {
      const frame = JSON.parse(line) as Record<string, unknown>
      const message = frame.message
      if (!message || typeof message !== 'object') continue
      const errorMessage = (message as Record<string, unknown>).errorMessage
      if (typeof errorMessage === 'string' && errorMessage.trim()) detail = errorMessage.trim()
    } catch {
      // A malformed diagnostic frame is not a reason to expose raw output.
    }
  }
  return detail
    ? (credential ? detail.replaceAll(credential, '[redacted]') : detail).replace(/[\r\n\u0000]/g, ' ').slice(0, 500)
    : null
}

function writeResponseChunk(response: import('node:http').ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.reject(new Error('REQUEST_ABORTED'))
  if (response.write(chunk)) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('REQUEST_ABORTED'))
    }
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('close', onClose)
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
  })
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
  // Force the status and streaming headers onto the socket before waiting for
  // the first Pi frame. Without this, Node may coalesce headers with the
  // first token and a slow/thinking worker looks like a stalled request to the
  // BFF and browser.
  response.flushHeaders?.()
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writeResponseChunk(response, value)
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
  // A host plugin install changes immutable files mounted into Codex Workers.
  // Include a local generation in the in-memory runtime identity so the next
  // lease cannot reuse a Worker created from the previous snapshot.
  let codexPluginSnapshotGeneration = 0
  const browserGateway = new BrowserGateway({
    publicBaseUrl: config.browserGatewayPublicUrl ?? `http://${config.host}:${config.port}`,
    allowedOrigins: config.browserGatewayAllowedOrigins ?? ['http://localhost:3000'],
    upstreamOrigin: config.browserGatewayUpstreamOrigin,
  })
  const codeServerGateway = new CodeServerGateway({
    publicBaseUrl: config.browserGatewayPublicUrl ?? `http://${config.host}:${config.port}`,
    allowedOrigins: config.browserGatewayAllowedOrigins ?? ['http://localhost:3000'],
  })
  // Runtime creation/model switching is serialized per Cloud session. Without
  // this lock two tabs can both observe a missing entry, create two sandboxes,
  // and then race while deleting each other's runtime.
  const sessionCreationLocks = new Map<string, Promise<void>>()
  // The web BFF can cancel a disconnected client while still draining the
  // worker response. Keeping the controller separately from SessionEntry
  // means cancellation is safe even when a model/browser identity is being
  // replaced under the same durable chat session.
  const activePromptControllers = new Map<string, AbortController>()
  // Per-session locks do not serialize creation for different sessions. Keep
  // a reservation count while backend.createSession is awaiting OpenSandbox
  // so maxSessions cannot be exceeded by concurrent provisioning requests.
  let creatingSessions = 0
  // Cleanup work can outlive the HTTP request that triggered it (for example
  // the idle reaper). Keep it visible to shutdown so the OpenSandbox transport
  // is never closed while a DELETE is still in flight.
  const cleanupOperations = new Set<Promise<void>>()
  const trackCleanup = (operation: Promise<void>): Promise<void> => {
    let tracked!: Promise<void>
    tracked = operation.finally(() => cleanupOperations.delete(tracked))
    cleanupOperations.add(tracked)
    return tracked
  }

  async function withSessionCreationLock<T>(baseKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionCreationLocks.get(baseKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => current)
    sessionCreationLocks.set(baseKey, queued)
    try {
      await previous
      return await operation()
    } finally {
      release()
      if (sessionCreationLocks.get(baseKey) === queued) sessionCreationLocks.delete(baseKey)
    }
  }

  async function prepareSessionRequest(input: {
    userId: string
    workspaceId: string
    sessionId: string
    projectId: string
    runtimeConfiguration: AgentProviderRuntimeConfiguration
    nativeSession?: AgentNativeSessionSnapshot
    browserSessionId?: string
    agent?: 'pi' | 'codex'
    accessMode?: 'restricted' | 'ask' | 'open'
  }): Promise<PreparedSessionRequest> {
    // Resolve and authorize the browser binding before provisioning a Project
    // VM or session storage. A stale/foreign browser id must not cause a
    // resource-creating side effect.
    const browser = input.browserSessionId
      ? browserGateway.getAgentSession(input.browserSessionId, {
        ownerId: input.userId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      })
      : undefined
    let projectRuntime: ProjectRuntimeDescriptor | undefined
    if (config.projectRuntimeManager) {
      projectRuntime = await config.projectRuntimeManager.ensure(input.projectId, undefined, 'agent')
    } else if (config.projectVmManager) {
      await config.projectVmManager.ensure(input.projectId)
    }
    if (config.requireProjectRuntime && !projectRuntime) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    if (config.projectRuntimeManager) {
      await config.projectRuntimeManager.prepareSessionStorage(input.projectId, input.userId, input.workspaceId, input.sessionId)
      await config.projectRuntimeManager.ensureProjectGitRepository(input.projectId)
    }
    const baseKey = `${input.userId}:${input.workspaceId}:${input.sessionId}`
    // Permissions configure Codex's process-level sandbox and approval mode.
    // Include them in the runtime identity so a user-visible mode change
    // recreates the worker with the new policy rather than only updating DB.
    const runtimeIdentity = `${input.runtimeConfiguration.providerId}/${input.runtimeConfiguration.modelId}@${input.runtimeConfiguration.revision}:agent=${input.agent ?? 'pi'}:access=${input.accessMode ?? 'restricted'}:plugins=${input.agent === 'codex' ? codexPluginSnapshotGeneration : 'none'}`
    return {
      ...input,
      browser,
      projectRuntime,
      baseKey,
      key: `${baseKey}:${runtimeIdentity}`,
    }
  }

  function pausePath(input: { userId: string; workspaceId: string; sessionId: string }): string {
    return join(config.storageRoot, '.session-controls', input.userId, input.workspaceId, `${input.sessionId}.json`)
  }
  async function readUserPause(input: { userId: string; workspaceId: string; sessionId: string }): Promise<boolean> {
    try { return JSON.parse(await readFile(pausePath(input), 'utf8')).paused === true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  async function writeUserPause(input: { userId: string; workspaceId: string; sessionId: string }, paused: boolean): Promise<void> {
    const path = pausePath(input)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify({ paused }), { mode: 0o600 })
    await rename(temporary, path)
  }

  async function createEntry(request: PreparedSessionRequest): Promise<{ entry: SessionEntry; created: boolean }> {
    return withSessionCreationLock(request.baseKey, async () => {
      const updateBrowser = async (entry: SessionEntry): Promise<boolean> => {
        // Omission means "leave the current optional capability unchanged" so
        // the browser-independent project keepalive cannot detach a live tab.
        if (request.browserSessionId === undefined || entry.browserSessionId === request.browserSessionId) return true
        if (!entry.runtime.setBrowser) return false
        await entry.runtime.setBrowser(request.browser)
        entry.browserSessionId = request.browserSessionId
        return true
      }
      // Re-check after waiting for another request that may have created the
      // same provider/model/agent runtime while this request was queued.
      const existingForKey = sessions.get(request.key)
      if (existingForKey) {
        if (await updateBrowser(existingForKey)) return { entry: existingForKey, created: false }
      }

      // A model/provider/browser switch replaces the old runtime before global
      // capacity is evaluated. With maxSessions=1 the old ordering incorrectly
      // returned SESSION_BUSY even though the session was safely replaceable.
      for (const [existingKey, existing] of sessions) {
        if (!existingKey.startsWith(`${request.baseKey}:`)) continue
        if (existing.busy || existing.recovering) throw new AgentHostError('SESSION_BUSY', 'Agent session is changing model while a prompt is active', { retryable: true })
        await existing.runtime.cleanup()
        if (sessions.get(existingKey) === existing) sessions.delete(existingKey)
      }
      if (config.maxSessions !== undefined && sessions.size + creatingSessions >= config.maxSessions) {
        throw new AgentHostError('SESSION_BUSY', 'This runtime has reached its concurrent session limit', { retryable: true })
      }
      creatingSessions += 1
      try {
        const recoveredRuntime = await backend.recoverSession?.(
          request.userId,
          request.workspaceId,
          request.sessionId,
          request.runtimeConfiguration,
          request.nativeSession,
          request.projectId,
          request.projectRuntime,
          request.browser,
          { agent: request.agent, accessMode: request.accessMode },
        )
        if (recoveredRuntime) {
          const entry: SessionEntry = { runtime: recoveredRuntime, lastUsedAt: Date.now(), busy: false, paused: false, userPaused: await readUserPause(request), browserSessionId: request.browserSessionId }
          sessions.set(request.key, entry)
          return { entry, created: false }
        }
        // No compatible durable lease was recoverable. Reclaim only this
        // exact stale workload before materialising its replacement.
        await backend.cleanupSession?.(request.userId, request.workspaceId, request.sessionId, request.projectId, request.projectRuntime)
        const entry: SessionEntry = {
          runtime: await backend.createSession(
            request.userId,
            request.workspaceId,
            request.sessionId,
            request.runtimeConfiguration,
            request.nativeSession,
            request.projectId,
            request.projectRuntime,
            request.browser,
            { agent: request.agent, accessMode: request.accessMode },
          ),
          lastUsedAt: Date.now(),
          busy: false,
          paused: false,
          userPaused: await readUserPause(request),
          browserSessionId: request.browserSessionId,
        }
        sessions.set(request.key, entry)
        return { entry, created: true }
      } finally {
        creatingSessions -= 1
      }
    })
  }

  async function handlePrompt(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new AgentHostError('INVALID_SESSION', 'sessionId is invalid')
    const body = parsePromptBody(await readJson(request))
    if (!body.projectId) throw new AgentHostError('INVALID_BODY', 'projectId is required for agent sessions')
    let createdEntryByRequest = false
    const abortController = new AbortController()
    const preparingKey = `${body.userId}:${body.workspaceId}:${sessionId}`
    if (activePromptControllers.has(preparingKey)) throw new AgentHostError('SESSION_BUSY', 'Session already has an active or preparing prompt', { retryable: true })
    // Reserve cancellation ownership before ANY slow VM/Worker preparation.
    // Previously /cancel during ensure() succeeded without finding a target,
    // and the abandoned prompt could start minutes later.
    activePromptControllers.set(preparingKey, abortController)
    // Normal direct Agent Host clients are canceled when their HTTP response
    // closes. The web BFF sets this opt-in header because it has a separate
    // /cancel request and must drain the worker's final native-session delta
    // into Postgres after the browser tab disappears.
    const drainOnClose = request.headers['x-openlink-drain-on-close'] === '1'
    let closeAbortTimer: NodeJS.Timeout | undefined
    response.once('close', () => {
      if (activePromptControllers.get(preparingKey) === abortController) activePromptControllers.delete(preparingKey)
      if (response.writableEnded) return
      if (!drainOnClose) {
        abortController.abort()
        return
      }
      // If the BFF disconnects before Agent Host has materialised the active
      // controller, its explicit /cancel request can race provisioning. Keep
      // a short safety timer so a lost cancel request cannot strand a worker,
      // while still leaving enough time for the normal final JSONL flush.
      closeAbortTimer = setTimeout(() => {
        closeAbortTimer = undefined
        abortController.abort()
      }, 5_000)
      closeAbortTimer.unref()
    })
    const prepared = await prepareSessionRequest({
      userId: body.userId, workspaceId: body.workspaceId, sessionId, projectId: body.projectId,
      runtimeConfiguration: body.runtimeConfiguration, nativeSession: body.nativeSession,
      browserSessionId: body.browserSessionId, agent: body.agent, accessMode: body.accessMode,
    })
    if (abortController.signal.aborted || response.destroyed) throw new AgentHostError('REQUEST_ABORTED', 'Agent request was aborted before Worker creation')
    const runPrompt = async (entry: SessionEntry): Promise<void> => {
      if (entry.userPaused) throw new AgentHostError('SESSION_BUSY', 'Session is paused; resume it before sending a message', { retryable: true })
      if (entry.busy || entry.recovering) throw new AgentHostError('SESSION_BUSY', 'Agent session is already processing a prompt', { retryable: true })
      if (entry.paused) {
        await entry.runtime.resume?.()
        entry.paused = false
      }
      entry.busy = true
      entry.lastUsedAt = Date.now()
      try {
        await pipeResponse(await entry.runtime.prompt(body.message, abortController.signal, body.attachments), response, config.transport)
      } finally {
        if (closeAbortTimer) {
          clearTimeout(closeAbortTimer)
          closeAbortTimer = undefined
        }
        entry.busy = false
        entry.lastUsedAt = Date.now()
      }
    }

    let entry = sessions.get(prepared.key)
    if (!entry) {
      const created = await createEntry(prepared)
      entry = created.entry
      createdEntryByRequest = created.created
    }
    // A client may disconnect while Project VM/session provisioning is still
    // in flight. Do not start a prompt against a request that can no longer
    // consume the stream, and release an entry created solely for that
    // abandoned request instead of waiting for the idle reaper.
    if (abortController.signal.aborted) {
      if (createdEntryByRequest && sessions.get(prepared.key) === entry) {
        // Keep a failed cleanup in the session map as a capacity barrier. A
        // request can disconnect after OpenSandbox has allocated a workload;
        // deleting the entry before DELETE succeeds would make that workload
        // permanently invisible to the reaper.
        entry.recovering = true
        try {
          await trackCleanup(entry.runtime.cleanup())
          if (sessions.get(prepared.key) === entry) sessions.delete(prepared.key)
        } catch (cleanupError) {
          entry.recovering = false
          entry.lastUsedAt = Date.now()
          console.error(`OpenLink aborted Agent session cleanup failed for ${prepared.key}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        }
      }
      throw new AgentHostError('REQUEST_ABORTED', 'Agent request was aborted', { retryable: true })
    }
    const activeControllerKey = prepared.baseKey
    if (activePromptControllers.has(activeControllerKey) && activePromptControllers.get(activeControllerKey) !== abortController) {
      throw new AgentHostError('SESSION_BUSY', 'Agent session is already processing a prompt', { retryable: true })
    }
    activePromptControllers.set(activeControllerKey, abortController)
    try {
      await runPrompt(entry)
    } catch (error) {
      // OpenSandbox may expire a workload independently of this process (for
      // example after an Agent Host restart or an older TTL configuration).
      // The Cloud Pi JSONL snapshot is the source of truth, so rebuild the
      // workload once when the first request reaches a missing sandbox. Only
      // retry before headers are sent; a mid-stream failure must not duplicate
      // assistant/tool output.
      if (!isMissingSandboxFailure(error) || response.headersSent) throw error
      entry.recovering = true
      // A missing workload is recoverable only after its old handle has been
      // disposed.  Ignoring a failed DELETE here used to create a replacement
      // sandbox while the old one remained allocated, so every recovery retry
      // leaked one workload.  Keep the entry as a capacity barrier and fail
      // closed when cleanup cannot be confirmed.
      try {
        await entry.runtime.cleanup()
      } catch (cleanupError) {
        entry.recovering = false
        entry.lastUsedAt = Date.now()
        throw new AgentHostError(
          'PROVISIONING_FAILED',
          `Expired Agent session cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { retryable: true },
        )
      }
      if (sessions.get(prepared.key) === entry) sessions.delete(prepared.key)
      entry = (await createEntry(prepared)).entry
      await runPrompt(entry)
    } finally {
      if (activePromptControllers.get(activeControllerKey) === abortController) activePromptControllers.delete(activeControllerKey)
    }
  }

  async function handleBrowserCreate(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    const body = parseBrowserSessionBody(await readJson(request))
    const runtime = await config.projectRuntimeManager.ensure(projectId, 'thin')
    const browser = new BrowserHostClient({ baseUrl: runtime.browserHostEndpoint, serviceToken: runtime.browserApiToken })
    const session = await browser.createSession({
      ownerId: body.ownerId,
      workspaceId: body.workspaceId,
      projectId,
      profileKey: body.profileKey,
      surface: body.surface,
      viewport: body.viewport as never,
      preview: body.preview as Record<string, unknown> | undefined,
      chromium: body.chromium as Record<string, unknown> | undefined,
    })
    let publicSession
    try {
      publicSession = browserGateway.register(session)
    } catch (error) {
      await browser.close(session.state.id).catch(() => undefined)
      throw error
    }
    json(response, 201, {
      version: 1,
      session: publicSession.state,
      connection: publicSession.connection,
    })
  }

  async function handleProjectPreviewTarget(
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    const target = await config.projectRuntimeManager.discoverPreviewTarget(projectId)
    if (!target) {
      json(response, 200, { target: null })
      return
    }
    json(response, 200, {
      target: {
        url: target.url,
        headers: target.headers,
        port: target.port,
        sandboxId: target.sandboxId,
      },
    })
  }

  // Exposes only the safe, publishable Project Supabase connection material
  // (gateway URL + publishable/anon key + revision). The service-role key and
  // database password are never stored on the descriptor, so this endpoint
  // cannot leak administrative credentials to the browser or the Agent.
  async function handleProjectSupabase(
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    const supabase = config.projectRuntimeManager.describeSupabase
      ? await config.projectRuntimeManager.describeSupabase(projectId)
      : (await config.projectRuntimeManager.ensure(projectId, 'thin')).supabase
    if (!supabase) {
      json(response, 200, { supabase: null })
      return
    }
    json(response, 200, {
      supabase: {
        url: supabase.url,
        publishableKey: supabase.publishableKey,
        anonKey: supabase.anonKey,
        revision: supabase.revision,
      },
    })
  }

  async function handleProjectSupabaseManagement(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager?.manageSupabase) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project Supabase management is not configured')
    const body = parseProjectSupabaseManagementBody(await readJson(request))
    json(response, 200, await config.projectRuntimeManager.manageSupabase(projectId, body))
  }

  async function handleProjectSupabaseStudioProxy(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager?.proxySupabaseStudio) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project Supabase Studio proxy is not configured')
    json(response, 200, await config.projectRuntimeManager.proxySupabaseStudio(projectId, parseProjectSupabaseStudioProxyBody(await readJson(request))))
  }

  async function handleProjectGitVersions(
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    json(response, 200, { versions: await config.projectRuntimeManager.listGitVersions(projectId) })
  }

  async function handleProjectWorkspaceFiles(
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    json(response, 200, { files: await config.projectRuntimeManager.listWorkspaceFiles(projectId) })
  }

  async function handleProjectGitCheckout(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    const { ref } = parseGitCheckoutBody(await readJson(request))
    json(response, 200, { version: await config.projectRuntimeManager.checkoutGitVersion(projectId, ref) })
  }

  async function handleBrowserDelete(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    projectId: string,
    browserSessionId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(browserSessionId)) throw new AgentHostError('INVALID_BODY', 'browserSessionId is invalid')
    const identity = parseBrowserDeleteBody(await readJson(request))
    // Deleting a browser session must never provision a stopped Project VM.
    // A missing active descriptor means the Browser Host is already gone (or
    // the Agent Host restarted), so the public operation is idempotently done.
    let runtime = config.projectRuntimeManager.getActive(projectId)
    // Agent Host restarts clear the in-memory descriptor and public gateway
    // binding, but Browser Host sessions can still be alive inside the durable
    // Project VM. Rehydrate that Project only when a ready runtime record is
    // present; an arbitrary stale browser id must not boot a new VM.
    if (!runtime && await config.projectRuntimeManager.hasPersistedRuntime(projectId)) {
      runtime = await config.projectRuntimeManager.ensure(projectId)
    }
    if (runtime) {
      const browser = new BrowserHostClient({ baseUrl: runtime.browserHostEndpoint, serviceToken: runtime.browserApiToken })
      const bound = (() => {
        try {
          return browserGateway.getAgentSession(browserSessionId, { ...identity, projectId })
        } catch {
          return null
        }
      })()
      if (!bound) {
        const state = await browser.get(browserSessionId)
        if (!state || state.ownerId !== identity.ownerId || state.workspaceId !== identity.workspaceId || state.projectId !== projectId) {
          throw new AgentHostError('BROWSER_SESSION_FAILED', 'Browser session does not belong to this project')
        }
      }
      // Browser Host retains a failed close for retry. Only remove the public
      // gateway binding after close has actually succeeded, otherwise a live
      // Chromium/tunnel session becomes unreachable and leaks until restart.
      await browser.close(browserSessionId)
      browserGateway.unregister(browserSessionId)
    } else {
      browserGateway.unregister(browserSessionId)
    }
    response.writeHead(204)
    response.end()
  }

  async function handleCodeServerCreate(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    projectId: string,
  ): Promise<void> {
    if (!config.projectRuntimeManager) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
    const body = parseCodeServerSessionBody(await readJson(request))
    const runtime = await config.projectRuntimeManager.ensure(projectId)
    const session = codeServerGateway.create({
      ownerId: body.ownerId,
      workspaceId: body.workspaceId,
      projectId,
      upstream: runtime.codeServerEndpoint,
    })
    json(response, 201, { version: 1, session })
  }

  async function handleAgentLease(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    pathSessionId: string,
  ): Promise<void> {
    const body = parseLeaseBody(await readJson(request))
    if (body.sessionId !== pathSessionId) throw new AgentHostError('INVALID_BODY', 'Lease session does not match the route')
    const baseKey = `${body.userId}:${body.workspaceId}:${body.sessionId}`
    // A lease with a runtime configuration is the chat-page warmup request.
    // It materialises the Worker before the first prompt so the prompt path
    // only has to resume an already prepared runtime. Requests without the
    // configuration remain lightweight legacy heartbeats.
    if (body.runtimeConfiguration) {
      const prepared = await prepareSessionRequest({
        userId: body.userId,
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
        projectId: body.projectId,
        runtimeConfiguration: body.runtimeConfiguration,
        nativeSession: body.nativeSession,
        browserSessionId: body.browserSessionId,
        agent: body.agent,
        accessMode: body.accessMode,
      })
      const { entry } = await createEntry(prepared)
      if (entry.userPaused) return json(response, 200, { ok: true, active: 1, ready: true, paused: true })
      if (entry.paused) {
        await entry.runtime.resume?.()
        entry.paused = false
      }
      entry.lastUsedAt = Date.now()
      return json(response, 200, { ok: true, active: 1, ready: true, paused: false })
    }
    let active = 0
    const now = Date.now()
    for (const [key, entry] of sessions) {
      if (!key.startsWith(`${baseKey}:`)) continue
      if (entry.userPaused) { active += 1; continue }
      if (entry.paused) {
        await entry.runtime.resume?.()
        entry.paused = false
      }
      entry.lastUsedAt = now
      active += 1
    }
    json(response, 200, { ok: true, active })
  }

  async function handleRuntimeResources(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    pathSessionId: string,
    resourceRequest?: AgentResourceRequest,
  ): Promise<void> {
    const raw = await readJson(request)
    const body = parseLeaseBody(raw)
    if (body.sessionId !== pathSessionId) throw new AgentHostError('INVALID_BODY', 'Runtime resource session does not match the route')
    if (resourceRequest?.scope === 'title') {
      const prompt = (raw as Record<string, unknown>).titlePrompt
      if (typeof prompt !== 'string' || !prompt.trim()) throw new AgentHostError('INVALID_BODY', 'Title prompt is required')
      resourceRequest = { scope: 'title', query: prompt.slice(0, 4000) }
    }
    const baseKey = `${body.userId}:${body.workspaceId}:${body.sessionId}`
    let entry = [...sessions.entries()].find(([key]) => key.startsWith(`${baseKey}:`))?.[1]
    // Resource discovery is a first-class Agent operation, not a passive
    // cache lookup.  If Agent Host restarted, the command palette must be
    // able to materialize the exact session runtime without requiring a fake
    // user turn first.
    if (!entry && body.runtimeConfiguration) {
      const prepared = await prepareSessionRequest({
        userId: body.userId,
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
        projectId: body.projectId,
        runtimeConfiguration: body.runtimeConfiguration,
        nativeSession: body.nativeSession,
        browserSessionId: body.browserSessionId,
        agent: body.agent,
        accessMode: body.accessMode,
      })
      entry = (await createEntry(prepared)).entry
    }
    if (!entry) throw new AgentHostError('INVALID_SESSION', 'Agent runtime configuration is required to restore this session', { retryable: true })
    if (entry.paused) {
      await entry.runtime.resume?.()
      entry.paused = false
    }
    if (!entry.runtime.resources) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'This Agent backend does not expose runtime resources', { retryable: true })
    entry.lastUsedAt = Date.now()
    json(response, 200, await entry.runtime.resources(resourceRequest))
  }

  async function handleAgentCancel(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    pathSessionId: string,
  ): Promise<void> {
    const body = parseLeaseBody(await readJson(request))
    if (body.sessionId !== pathSessionId) throw new AgentHostError('INVALID_BODY', 'Cancel session does not match the route')
    const baseKey = `${body.userId}:${body.workspaceId}:${body.sessionId}`
    const controller = activePromptControllers.get(baseKey)
    if (controller) controller.abort()
    let active = false
    for (const [key, entry] of sessions) {
      if (!key.startsWith(`${baseKey}:`)) continue
      entry.lastUsedAt = Date.now()
      active = active || entry.busy
    }
    json(response, 202, { ok: true, active })
  }

  async function handleExtensionUiResponse(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    pathSessionId: string,
  ): Promise<void> {
    const raw = await readJson(request)
    if (!raw || typeof raw !== 'object') throw new AgentHostError('INVALID_BODY', 'Extension UI response body is invalid')
    const payload = raw as Record<string, unknown>
    const body = parseLeaseBody({ ...payload, sessionId: pathSessionId })
    const uiResponse = parseExtensionUiResponse(payload)
    const baseKey = `${body.userId}:${body.workspaceId}:${body.sessionId}`
    const activeEntry = [...sessions.entries()].find(([key, entry]) => key.startsWith(`${baseKey}:`) && entry.busy && entry.runtime.resolveExtensionUi)
    if (!activeEntry?.[1].runtime.resolveExtensionUi) {
      throw new AgentHostError('EXTENSION_UI_UNAVAILABLE', 'No active extension UI request is waiting for this session', { retryable: true })
    }
    await activeEntry[1].runtime.resolveExtensionUi(uiResponse)
    activeEntry[1].lastUsedAt = Date.now()
    json(response, 202, { ok: true })
  }

  async function handleNetworkAccess(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    pathSessionId: string,
  ): Promise<void> {
    const body = parseNetworkAccessBody(await readJson(request))
    const baseKey = `${body.userId}:${body.workspaceId}:${pathSessionId}`
    const activeEntry = [...sessions.entries()].find(([key, entry]) => key.startsWith(`${baseKey}:`) && entry.runtime.networkAccess)
    if (!activeEntry?.[1].runtime.networkAccess) {
      throw new AgentHostError('INVALID_SESSION', 'No active Agent session is available for network access', { retryable: true })
    }
    await activeEntry[1].runtime.networkAccess(body.hosts, body.mode, body.durationSeconds)
    activeEntry[1].lastUsedAt = Date.now()
    json(response, 202, { ok: true, hosts: body.hosts, mode: body.mode, durationSeconds: body.durationSeconds ?? null })
  }

  async function handleBrowserGatewayPreview(
    request: IncomingMessage,
    response: import('node:http').ServerResponse,
    browserSessionId: string,
  ): Promise<void> {
    await browserGateway.handleHttp(request, response, browserSessionId)
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, { ok: true, runtime: config.transport, sessions: sessions.size })
        return
      }
      const browserGatewayPreview = /^\/v1\/browser\/gateway\/sessions\/([^/]+)\/preview(?:\/|$)/.exec(url.pathname)
      if (browserGatewayPreview) {
        await handleBrowserGatewayPreview(request, response, decodeURIComponent(browserGatewayPreview[1]!))
        return
      }
      const codeServerGatewayRequest = /^\/v1\/code-server\/gateway\/sessions\/([^/]+)(?:\/|$)/.exec(url.pathname)
      if (codeServerGatewayRequest) {
        await codeServerGateway.handleHttp(request, response, decodeURIComponent(codeServerGatewayRequest[1]!))
        return
      }
      // The MCP endpoint performs its own authorization: it accepts either the
      // internal Bearer token or a project-scoped capability minted for the
      // in-VM agent session, so it must run before the global Bearer guard.
      const supabaseMcpRequest = /^\/v1\/projects\/([^/]+)\/supabase\/mcp$/.exec(url.pathname)
      if (supabaseMcpRequest && request.method === 'POST') {
        const projectId = decodeURIComponent(supabaseMcpRequest[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('AUTH_DENIED', 'Agent Host authorization is invalid')
        if (!config.projectRuntimeManager?.manageSupabase) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project Supabase management is not configured')
        await handleSupabaseMcpRequest({
          request,
          response,
          projectId,
          apiToken: config.apiToken,
          manage: (operation, extra) => config.projectRuntimeManager!.manageSupabase!(projectId, { operation, ...extra }),
          resolveAccessMode: async (sessionId) => {
            if (!config.resolveSupabaseAccessMode) return 'restricted'
            return config.resolveSupabaseAccessMode(sessionId)
          },
        })
        return
      }
      // Session Supabase write-confirmation approval (internal Bearer only) and listing.
      if (!authorized(request, config.apiToken)) throw new AgentHostError('AUTH_DENIED', 'Agent Host authorization is invalid')
      if (request.method === 'POST' && url.pathname === '/v1/agent/plugins/invalidate') {
        if (!config.invalidateCodexPluginSnapshot) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Codex plugin snapshot invalidation is not configured')
        config.invalidateCodexPluginSnapshot()
        codexPluginSnapshotGeneration += 1
        json(response, 200, { ok: true })
        return
      }
      // Session Supabase write-confirmation approval/listing (internal Bearer).
      const confirmationApprove = /^\/v1\/projects\/([^/]+)\/supabase\/mcp\/confirmations\/([^/]+)\/approve$/.exec(url.pathname)
      if (confirmationApprove && request.method === 'POST') {
        const body = await readJson(request).catch(() => ({})) as { userId?: unknown }
        const approver = typeof body.userId === 'string' ? body.userId : 'system'
        const approved = approveSupabaseMcpConfirmation(decodeURIComponent(confirmationApprove[2]!), approver)
        json(response, approved ? 202 : 404, approved ? { ok: true } : { error: { code: 'CONFIRMATION_NOT_FOUND' } })
        return
      }
      const confirmationList = /^\/v1\/projects\/([^/]+)\/supabase\/mcp\/confirmations$/.exec(url.pathname)
      if (confirmationList && request.method === 'GET') {
        const sessionId = requestHeader(request, 'x-openlink-session-id') ?? ''
        json(response, 200, { confirmations: listPendingSupabaseMcpConfirmations(sessionId) })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/providers/check') {
        if (config.maxSessions !== undefined && sessions.size + creatingSessions >= config.maxSessions) {
          throw new AgentHostError('SESSION_BUSY', 'This runtime has reached its concurrent session limit', { retryable: true })
        }
        creatingSessions += 1
        try {
          const body = parseProviderCheckBody(await readJson(request))
          const sessionId = `provider-check-${randomBytes(8).toString('hex')}`
          let projectRuntime: ProjectRuntimeDescriptor | undefined
          if (config.projectRuntimeManager) {
            projectRuntime = await config.projectRuntimeManager.ensure(body.projectId)
            await config.projectRuntimeManager.prepareSessionStorage(body.projectId, body.userId, body.workspaceId, sessionId)
          } else if (config.requireProjectRuntime) {
            throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required')
          }
          const runtime = await backend.createSession(body.userId, body.workspaceId, sessionId, body.runtimeConfiguration, undefined, body.projectId, projectRuntime)
          try {
            const upstream = await runtime.prompt('Reply with exactly the word OK.', AbortSignal.timeout(90_000))
            if (!upstream.ok || !upstream.body) throw new AgentHostError('PI_PROMPT_FAILED', 'Provider check request failed')
            const output = await upstream.text()
            if (/"type"\s*:\s*"extension_error"/.test(output) || /"stopReason"\s*:\s*"error"/.test(output)) {
              const detail = providerCheckFailureDetail(output, body.runtimeConfiguration.apiKey)
              throw new AgentHostError('PI_PROMPT_FAILED', detail ? `The model provider rejected the connectivity check: ${detail}` : 'The model provider rejected the connectivity check')
            }
            json(response, 200, { ok: true, providerId: body.runtimeConfiguration.providerId, modelId: body.runtimeConfiguration.modelId })
          } finally {
            try {
              await trackCleanup(runtime.cleanup())
            } catch (cleanupError) {
              // Keep a failed provider-check cleanup in the normal reaper path;
              // returning a successful connectivity check must not strand its
              // temporary sandbox outside the session map.
              const cleanupKey = `provider-check:${sessionId}`
              sessions.set(cleanupKey, {
                runtime,
                lastUsedAt: Date.now() - config.sessionIdleTtlMs - 1,
                busy: false,
              })
              console.error(`OpenLink provider-check cleanup failed for ${sessionId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
            }
          }
          return
        } finally {
          creatingSessions -= 1
        }
      }
      const leaseMatch = /^\/v1\/agent\/sessions\/([^/]+)\/lease$/.exec(url.pathname)
      if (request.method === 'POST' && leaseMatch) {
        const sessionId = decodeURIComponent(leaseMatch[1]!)
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new AgentHostError('INVALID_SESSION', 'sessionId is invalid')
        await handleAgentLease(request, response, sessionId)
        return
      }
      const resourcesMatch = /^\/v1\/agent\/sessions\/([^/]+)\/resources$/.exec(url.pathname)
      if (request.method === 'POST' && resourcesMatch) {
        const sessionId = decodeURIComponent(resourcesMatch[1]!)
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new AgentHostError('INVALID_SESSION', 'sessionId is invalid')
        const scope = url.searchParams.get('scope')
        await handleRuntimeResources(request, response, sessionId, {
          ...(scope === 'command' || scope === 'mention' || scope === 'skill' || scope === 'title' ? { scope } : {}),
          ...(url.searchParams.has('command') ? { command: url.searchParams.get('command') ?? '' } : {}),
          ...(url.searchParams.has('query') ? { query: url.searchParams.get('query') ?? '' } : {}),
        })
        return
      }
      const controlMatch = /^\/v1\/agent\/sessions\/([^/]+)\/control$/.exec(url.pathname)
      if (request.method === 'POST' && controlMatch) {
        const sessionId = decodeURIComponent(controlMatch[1]!)
        const raw = await readJson(request) as Record<string, unknown>
        const body = parseLeaseBody(raw)
        if (body.sessionId !== sessionId) throw new AgentHostError('INVALID_BODY', 'Session does not match route')
        if (typeof raw.action !== 'string' || !['status', 'interrupt', 'pause', 'resume', 'steer', 'plan', 'default', 'goal', 'goal-clear', 'compact', 'rewind', 'fork'].includes(raw.action)
          || (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > 100000))
          || (raw.targetSessionId !== undefined && (typeof raw.targetSessionId !== 'string' || !/^[A-Za-z0-9]{11}$/.test(raw.targetSessionId)))) throw new AgentHostError('INVALID_BODY', 'Invalid session control')
        const baseKey = `${body.userId}:${body.workspaceId}:${sessionId}`
        const entry = [...sessions.entries()].find(([key]) => key.startsWith(`${baseKey}:`))?.[1]
        if (raw.action === 'interrupt') {
          activePromptControllers.get(baseKey)?.abort()
          return json(response, 200, { ok: true, paused: entry?.userPaused === true, busy: entry?.busy === true })
        }
        if (raw.action === 'pause') {
          await writeUserPause(body, true)
          if (entry) entry.userPaused = true
          activePromptControllers.get(baseKey)?.abort()
          return json(response, 200, { ok: true, paused: true, busy: entry?.busy === true })
        }
        if (!entry) throw new AgentHostError('INVALID_SESSION', 'Agent session is not ready', { retryable: true })
        if (raw.action === 'resume') {
          if (entry.paused) await entry.runtime.resume?.()
          await writeUserPause(body, false)
          entry.paused = false
          entry.userPaused = false
          entry.lastUsedAt = Date.now()
          return json(response, 200, { ok: true, paused: false })
        }
        if (entry.userPaused && raw.action !== 'status') throw new AgentHostError('SESSION_BUSY', 'Session is paused', { retryable: true })
        if (!entry.runtime.control) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Worker does not support session controls')
        if (raw.action === 'fork') {
          if (typeof raw.targetSessionId !== 'string' || raw.targetSessionId === sessionId) throw new AgentHostError('INVALID_BODY', 'A distinct target session is required')
          if (!config.projectRuntimeManager || !body.projectId) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Project runtime manager is required to persist a fork')
        }
        const result = await entry.runtime.control({ action: raw.action, text: raw.text as string | undefined })
        if (raw.action === 'fork') {
          const threadId = (result && typeof result === 'object' && !Array.isArray(result)) ? (result as Record<string, unknown>).threadId : undefined
          if (typeof threadId !== 'string') throw new AgentHostError('INVALID_BODY', 'Codex fork did not return a thread id')
          await config.projectRuntimeManager!.persistCodexThreadId(body.projectId!, body.userId, body.workspaceId, raw.targetSessionId as string, threadId)
        }
        return json(response, 200, { result, paused: entry.userPaused === true })
      }
      const cancelMatch = /^\/v1\/agent\/sessions\/([^/]+)\/cancel$/.exec(url.pathname)
      if (request.method === 'POST' && cancelMatch) {
        const sessionId = decodeURIComponent(cancelMatch[1]!)
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new AgentHostError('INVALID_SESSION', 'sessionId is invalid')
        await handleAgentCancel(request, response, sessionId)
        return
      }
      const extensionUiResponseMatch = /^\/v1\/agent\/sessions\/([^/]+)\/extension-ui-response$/.exec(url.pathname)
      if (request.method === 'POST' && extensionUiResponseMatch) {
        const sessionId = decodeURIComponent(extensionUiResponseMatch[1]!)
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new AgentHostError('INVALID_SESSION', 'sessionId is invalid')
        await handleExtensionUiResponse(request, response, sessionId)
        return
      }
      const networkAccessMatch = /^\/v1\/agent\/sessions\/([^/]+)\/network-access$/.exec(url.pathname)
      if (request.method === 'POST' && networkAccessMatch) {
        const sessionId = decodeURIComponent(networkAccessMatch[1]!)
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new AgentHostError('INVALID_SESSION', 'sessionId is invalid')
        await handleNetworkAccess(request, response, sessionId)
        return
      }
      const projectBrowserCreate = /^\/v1\/projects\/([^/]+)\/browser\/sessions$/.exec(url.pathname)
      if (request.method === 'POST' && projectBrowserCreate) {
        const projectId = decodeURIComponent(projectBrowserCreate[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleBrowserCreate(request, response, projectId)
        return
      }
      const projectPreviewTarget = /^\/v1\/projects\/([^/]+)\/preview-target$/.exec(url.pathname)
      if (request.method === 'GET' && projectPreviewTarget) {
        const projectId = decodeURIComponent(projectPreviewTarget[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleProjectPreviewTarget(response, projectId)
        return
      }
      const projectSupabase = /^\/v1\/projects\/([^/]+)\/supabase$/.exec(url.pathname)
      if (request.method === 'GET' && projectSupabase) {
        const projectId = decodeURIComponent(projectSupabase[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleProjectSupabase(response, projectId)
        return
      }
      const projectSupabaseManagement = /^\/v1\/projects\/([^/]+)\/supabase\/management$/.exec(url.pathname)
      if (request.method === 'POST' && projectSupabaseManagement) {
        const projectId = decodeURIComponent(projectSupabaseManagement[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleProjectSupabaseManagement(request, response, projectId)
        return
      }
      const projectSupabaseStudioProxy = /^\/v1\/projects\/([^/]+)\/supabase\/studio-proxy$/.exec(url.pathname)
      if (request.method === 'POST' && projectSupabaseStudioProxy) {
        const projectId = decodeURIComponent(projectSupabaseStudioProxy[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleProjectSupabaseStudioProxy(request, response, projectId)
        return
      }
      const projectGitVersions = /^\/v1\/projects\/([^/]+)\/git\/versions$/.exec(url.pathname)
      if (request.method === 'GET' && projectGitVersions) {
        const projectId = decodeURIComponent(projectGitVersions[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleProjectGitVersions(response, projectId)
        return
      }
      const projectWorkspaceFiles = /^\/v1\/projects\/([^/]+)\/workspace\/files$/.exec(url.pathname)
      if (request.method === 'GET' && projectWorkspaceFiles) {
        const projectId = decodeURIComponent(projectWorkspaceFiles[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleProjectWorkspaceFiles(response, projectId)
        return
      }
      const projectGitCheckout = /^\/v1\/projects\/([^/]+)\/git\/checkout$/.exec(url.pathname)
      if (request.method === 'POST' && projectGitCheckout) {
        const projectId = decodeURIComponent(projectGitCheckout[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleProjectGitCheckout(request, response, projectId)
        return
      }
      const projectBrowserDelete = /^\/v1\/projects\/([^/]+)\/browser\/sessions\/([^/]+)$/.exec(url.pathname)
      if (request.method === 'DELETE' && projectBrowserDelete) {
        const projectId = decodeURIComponent(projectBrowserDelete[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleBrowserDelete(request, response, projectId, decodeURIComponent(projectBrowserDelete[2]!))
        return
      }
      const projectCodeServerCreate = /^\/v1\/projects\/([^/]+)\/code-server\/sessions$/.exec(url.pathname)
      if (request.method === 'POST' && projectCodeServerCreate) {
        const projectId = decodeURIComponent(projectCodeServerCreate[1]!)
        if (!isProjectId(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
        await handleCodeServerCreate(request, response, projectId)
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
      // Keep detailed diagnostics on the trusted Host, not in the browser's
      // canonical error event. Codes alone cannot diagnose a failed create.
      console.error('OpenLink Agent Host request failed', {
        code: failure.code,
        message: failure.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2000),
      })
      const status = failure.code === 'AUTH_DENIED' ? 403 : failure.code === 'SESSION_BUSY' ? 409 : 400
      json(response, status, { error: { code: failure.code, message: failure.message, retryable: failure.retryable } })
    })
  })
  server.on('upgrade', (request, socket, head) => {
    if (!codeServerGateway.handleUpgrade(request, socket, head)) browserGateway.handleUpgrade(request, socket, head)
  })

  const reaper = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleTtlMs
    for (const [key, entry] of sessions) {
      if (entry.busy || entry.recovering || entry.paused || entry.lastUsedAt >= cutoff) continue
      entry.recovering = true
      if (entry.runtime.pause) {
        // Keep the sandbox snapshot and session handle in memory. Pausing
        // releases the Worker execution resources without stopping the
        // Project VM, and resume can reconnect to it on the next lease.
        void trackCleanup(entry.runtime.pause()).then(() => {
          entry.recovering = false
          entry.paused = true
        }).catch((error) => {
          entry.recovering = false
          entry.lastUsedAt = Date.now()
          console.error(`OpenLink idle Agent session pause failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
        })
      } else {
        // Backends without pause support retain the old destructive cleanup
        // behavior; the local OpenSandbox backend implements pause/resume.
        void trackCleanup(entry.runtime.cleanup()).then(() => {
          if (sessions.get(key) === entry) sessions.delete(key)
        }).catch((error) => {
          entry.recovering = false
          entry.lastUsedAt = Date.now()
          console.error(`OpenLink idle Agent session cleanup failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
  }, 60_000)
  reaper.unref()

  const shutdown = async (): Promise<void> => {
    clearInterval(reaper)
    await Promise.allSettled([...cleanupOperations])
    // Do not close the OpenSandbox transport while a model-switch/create lock
    // is still provisioning a workload for an in-flight request.
    await Promise.allSettled([...sessionCreationLocks.values()])
    if (!config.preserveSessionsOnShutdown) {
      await Promise.allSettled([...sessions.values()].map((entry) => {
        entry.recovering = true
        return trackCleanup(entry.runtime.cleanup())
      }))
      await Promise.allSettled([...cleanupOperations])
    }
    sessions.clear()
    codeServerGateway.close()
    browserGateway.close()
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
