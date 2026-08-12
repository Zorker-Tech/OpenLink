import { randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import type { BrowserAgentSession } from './browser-client.js'
import { AgentHostError } from './errors.js'

const MAX_HTML_BYTES = 20 * 1024 * 1024
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024
const COOKIE_PREFIX = 'openlink_browser_gateway_'

interface GatewayBinding {
  sessionId: string
  token: string
  ownerId: string
  agentSession: BrowserAgentSession
  eventsUrl: URL
  previewUrl?: URL
  expiresAt: number
  cleanupTimer: NodeJS.Timeout
}

export interface BrowserGatewayConfig {
  /** URL reachable by the user's browser, not the Project VM loopback URL. */
  publicBaseUrl: string
  /** Origins allowed to open the human control socket and preview iframe. */
  allowedOrigins: string[]
  /** Origin accepted by Browser Host when the gateway connects upstream. */
  upstreamOrigin?: string
}

export interface PublicBrowserSession {
  state: BrowserAgentSession['state']
  connection: {
    eventsUrl: string
    previewUrl?: string
    bridgeNonce?: string
  }
}

export interface BrowserAgentSessionIdentity {
  ownerId: string
  workspaceId: string
  projectId: string
}

function cookieName(sessionId: string): string {
  return `${COOKIE_PREFIX}${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 48)}`
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const raw = part.slice(index + 1).trim()
    try { cookies.set(name, decodeURIComponent(raw)) } catch { cookies.set(name, raw) }
  }
  return cookies
}

function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  return !!origin && allowed.includes(origin)
}

function safeTokenEquals(left: string | undefined, right: string): boolean {
  if (!left) return false
  const supplied = Buffer.from(left)
  const expected = Buffer.from(right)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function asWebSocketUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Browser gateway upstream events URL is invalid')
  return url
}

function asHttpUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Browser gateway upstream preview URL is invalid')
  return url
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function appendPath(base: string, path: string): string {
  return `${stripTrailingSlash(base)}/${path.replace(/^\/+/, '')}`
}

function closeSocket(socket: Duplex, status: number, message: string): void {
  const reason = message.replace(/[\r\n]/g, ' ').slice(0, 160)
  try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`) } finally { socket.destroy() }
}

/**
 * Public edge for Browser Host sessions.
 *
 * Project VMs intentionally expose Browser Host only through Agent Host
 * loopback forwarding. Returning that loopback URL to a remote browser makes
 * realtime control and native previews unusable, so this gateway terminates
 * the browser's scoped capability and proxies only the associated session.
 * The Browser Host service token and its internal capability tokens never
 * leave Agent Host.
 */
export class BrowserGateway {
  private readonly publicBaseUrl: string
  private readonly allowedOrigins: string[]
  private readonly upstreamOrigin: string
  private readonly bindings = new Map<string, GatewayBinding>()
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

  constructor(config: BrowserGatewayConfig) {
    const base = new URL(config.publicBaseUrl)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('Browser gateway public URL must use HTTP or HTTPS')
    this.publicBaseUrl = stripTrailingSlash(base.toString())
    this.allowedOrigins = [...new Set(config.allowedOrigins.map((origin) => origin.trim()).filter(Boolean))]
    if (!this.allowedOrigins.length) throw new Error('Browser gateway requires at least one allowed origin')
    this.upstreamOrigin = config.upstreamOrigin?.trim() || 'http://localhost:3000'
    // Validate once so a bad deployment cannot start with an origin that the
    // Browser Host would reject later during every websocket reconnect.
    new URL(this.upstreamOrigin)
  }

  register(session: BrowserAgentSession): PublicBrowserSession {
    this.unregister(session.state.id)
    const expiresAt = Math.max(Date.now() + 60_000, Date.parse(session.state.expiresAt) || Date.now() + 60_000)
    const token = randomBytes(32).toString('base64url')
    const eventsUrl = asWebSocketUrl(session.connection.eventsUrl)
    const previewUrl = session.connection.previewUrl ? asHttpUrl(session.connection.previewUrl) : undefined
    const cleanupTimer = setTimeout(() => this.unregister(session.state.id), Math.max(1_000, expiresAt - Date.now()))
    cleanupTimer.unref()
    const binding: GatewayBinding = { sessionId: session.state.id, token, ownerId: session.state.ownerId, agentSession: session, eventsUrl, previewUrl, expiresAt, cleanupTimer }
    this.bindings.set(binding.sessionId, binding)

    const publicEventsUrl = this.gatewayUrl(binding, 'events', true)
    const publicPreviewUrl = previewUrl ? this.gatewayUrl(binding, 'preview/__openlink_bootstrap', false) : undefined
    return {
      state: this.rewriteState(session.state, binding, publicPreviewUrl),
      connection: {
        eventsUrl: publicEventsUrl,
        previewUrl: publicPreviewUrl,
        bridgeNonce: session.connection.bridgeNonce,
      },
    }
  }

  unregister(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding) return
    clearTimeout(binding.cleanupTimer)
    this.bindings.delete(sessionId)
  }

  /**
   * Return the private Browser Host capability that belongs to an agent
   * request. The public gateway token is intentionally different from this
   * capability and is never returned to the Web UI. Identity is checked at
   * the Agent Host boundary so a leaked browser-session id cannot bind an
   * agent to another user's project.
   */
  getAgentSession(sessionId: string, identity: BrowserAgentSessionIdentity): BrowserAgentSession {
    const binding = this.requireBinding(sessionId)
    const state = binding.agentSession.state
    if (state.ownerId !== identity.ownerId || state.workspaceId !== identity.workspaceId || state.projectId !== identity.projectId) {
      throw new AgentHostError('BROWSER_SESSION_FAILED', 'Browser session does not belong to this agent session')
    }
    return binding.agentSession
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
    const binding = this.requireBinding(sessionId)
    this.assertRequestOrigin(request, false)
    const url = new URL(request.url || '/', this.publicBaseUrl)
    const prefix = this.previewPrefix(binding)
    const suffix = this.pathSuffix(url.pathname, prefix)
    const token = this.authorizePreview(request, url, binding)
    if (suffix === '/__openlink_bootstrap') {
      const secure = new URL(this.publicBaseUrl).protocol === 'https:' ? '; Secure' : ''
      response.setHeader('Set-Cookie', `${cookieName(sessionId)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=${prefix}/${secure}`)
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.writeHead(302, { Location: `${prefix}/` })
      response.end()
      return
    }

    const upstream = this.upstreamPreviewUrl(binding, suffix, url)
    await this.proxyHttp(request, response, binding, upstream)
  }

  handleUpgrade(request: IncomingMessage, rawSocket: Duplex, head: Buffer): void {
    const socket = rawSocket as Socket
    try {
      const url = new URL(request.url || '/', this.publicBaseUrl)
      const eventsMatch = /^\/v1\/browser\/gateway\/sessions\/([^/]+)\/events$/.exec(url.pathname)
      if (eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1]!)
        const binding = this.requireBinding(sessionId)
        this.assertRequestOrigin(request, true)
        this.authorizeToken(url.searchParams.get('token') ?? undefined, binding)
        this.proxyEventsWebSocket(request, socket, head, binding)
        return
      }
      const previewMatch = /^\/v1\/browser\/gateway\/sessions\/([^/]+)\/preview(?:\/|$)/.exec(url.pathname)
      if (previewMatch) {
        const sessionId = decodeURIComponent(previewMatch[1]!)
        const binding = this.requireBinding(sessionId)
        this.assertRequestOrigin(request, true)
        const token = this.authorizePreview(request, url, binding)
        const suffix = this.pathSuffix(url.pathname, this.previewPrefix(binding))
        const upstream = this.upstreamPreviewUrl(binding, suffix, url)
        this.proxyPreviewWebSocket(request, socket, head, binding, upstream)
        return
      }
      socket.destroy()
    } catch (error) {
      closeSocket(socket, 401, error instanceof Error ? error.message : 'Browser gateway authorization failed')
    }
  }

  close(): void {
    for (const binding of this.bindings.values()) clearTimeout(binding.cleanupTimer)
    this.bindings.clear()
    for (const client of this.sockets.clients) client.terminate()
    this.sockets.close()
  }

  private requireBinding(sessionId: string): GatewayBinding {
    const binding = this.bindings.get(sessionId)
    if (!binding || binding.expiresAt <= Date.now()) {
      this.unregister(sessionId)
      throw new AgentHostError('BROWSER_SESSION_FAILED', 'Browser session gateway binding is no longer available', { retryable: true })
    }
    return binding
  }

  private assertRequestOrigin(request: IncomingMessage, required: boolean): void {
    if (request.headers.origin && !isAllowedOrigin(request.headers.origin, this.allowedOrigins)) throw new Error('Browser gateway origin is not allowed')
    if (required && !request.headers.origin) throw new Error('Browser gateway origin is required')
  }

  private authorizeToken(token: string | undefined, binding: GatewayBinding): string {
    if (!safeTokenEquals(token, binding.token)) throw new Error('Browser gateway token is invalid')
    if (binding.expiresAt <= Date.now()) throw new Error('Browser gateway token expired')
    return binding.token
  }

  private authorizePreview(request: IncomingMessage, url: URL, binding: GatewayBinding): string {
    const cookie = parseCookies(request.headers.cookie).get(cookieName(binding.sessionId))
    return this.authorizeToken(url.searchParams.get('token') || cookie, binding)
  }

  private previewPrefix(binding: GatewayBinding): string {
    return `/v1/browser/gateway/sessions/${encodeURIComponent(binding.sessionId)}/preview`
  }

  private gatewayUrl(binding: GatewayBinding, suffix: string, websocket: boolean): string {
    const base = this.publicBaseUrl
    const path = `/v1/browser/gateway/sessions/${encodeURIComponent(binding.sessionId)}/${suffix.replace(/^\/+/, '')}`
    const url = `${base}${path}?token=${encodeURIComponent(binding.token)}`
    return websocket ? url.replace(/^http/, 'ws') : url
  }

  private pathSuffix(pathname: string, prefix: string): string {
    if (pathname === prefix) return '/'
    if (!pathname.startsWith(`${prefix}/`)) throw new Error('Browser gateway path is invalid')
    return pathname.slice(prefix.length) || '/'
  }

  private upstreamPreviewUrl(binding: GatewayBinding, suffix: string, external: URL): URL {
    if (!binding.previewUrl) throw new Error('Browser session does not expose a native preview')
    const upstreamBootstrap = binding.previewUrl
    if (suffix === '/inspector-bridge.js') {
      const bridge = new URL(upstreamBootstrap.origin)
      bridge.pathname = '/v1/browser/inspector-bridge.js'
      return bridge
    }
    const upstreamPrefix = upstreamBootstrap.pathname.replace(/\/__openlink_bootstrap$/, '')
    const upstream = new URL(upstreamBootstrap.origin)
    upstream.pathname = `${upstreamPrefix}${suffix === '/' ? '/' : suffix}`
    for (const [key, value] of external.searchParams) {
      if (key !== 'token') upstream.searchParams.append(key, value)
    }
    // Browser Host validates its own capability token; the gateway token is
    // deliberately never forwarded upstream.
    upstream.searchParams.set('token', upstreamBootstrap.searchParams.get('token') || '')
    return upstream
  }

  private rewriteState<T extends BrowserAgentSession['state']>(state: T, binding: GatewayBinding, publicPreviewUrl?: string): T {
    const internalPrefix = binding.previewUrl ? binding.previewUrl.pathname.replace(/\/__openlink_bootstrap$/, '') : undefined
    const publicPrefix = this.previewPrefix(binding)
    const rewrite = (value: string): string => {
      if (!internalPrefix) return value
      const internalOrigin = binding.previewUrl!.origin
      return value.replaceAll(`${internalOrigin}${internalPrefix}`, publicPrefix)
    }
    return {
      ...state,
      previewUrl: publicPreviewUrl,
      pages: state.pages.map((page) => ({ ...page, url: rewrite(page.url) })),
    } as T
  }

  private rewriteUpstreamText(value: string, binding: GatewayBinding): string {
    if (!binding.previewUrl) return value
    const internalPrefix = `${binding.previewUrl.origin}${binding.previewUrl.pathname.replace(/\/__openlink_bootstrap$/, '')}`
    const externalPrefix = this.previewPrefix(binding)
    return value
      .replaceAll(internalPrefix, externalPrefix)
      // The bootstrap response sets an HttpOnly gateway cookie. Keep the
      // injected bridge URL token-free so project page JavaScript cannot read
      // and exfiltrate the human Browser capability from its own DOM.
      .replaceAll('/v1/browser/inspector-bridge.js', `${externalPrefix}/inspector-bridge.js`)
  }

  private async proxyHttp(request: IncomingMessage, response: ServerResponse, binding: GatewayBinding, upstream: URL): Promise<void> {
    const headers = { ...request.headers }
    headers.host = upstream.host
    headers['accept-encoding'] = 'identity'
    delete headers.authorization
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const gatewayCookie = cookieName(binding.sessionId)
    const forwardedCookies = [...parseCookies(request.headers.cookie).entries()]
      .filter(([name]) => name !== gatewayCookie)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ')
    if (forwardedCookies) headers.cookie = forwardedCookies
    else delete headers.cookie

    const requestImpl = upstream.protocol === 'https:' ? httpsRequest : httpRequest
    const upstreamRequest = requestImpl({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: `${upstream.pathname}${upstream.search}`,
      headers,
      timeout: 30_000,
    })

    await new Promise<void>((resolve, reject) => {
      upstreamRequest.once('error', reject)
      upstreamRequest.once('timeout', () => upstreamRequest.destroy(new Error('Browser preview upstream timed out')))
      upstreamRequest.once('response', (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers }
        delete responseHeaders['content-length']
        delete responseHeaders['content-encoding']
        delete responseHeaders['transfer-encoding']
        delete responseHeaders['x-frame-options']
        if (typeof responseHeaders.location === 'string') {
          try {
            const location = new URL(responseHeaders.location, upstream)
            const internalPrefix = binding.previewUrl?.pathname.replace(/\/__openlink_bootstrap$/, '')
            if (internalPrefix && location.origin === upstream.origin && location.pathname.startsWith(internalPrefix)) {
              // Never echo Browser Host's signed preview capability in a
              // redirect. The gateway cookie already authenticates the next
              // request; a public gateway token is only needed on bootstrap.
              location.searchParams.delete('token')
              responseHeaders.location = `${this.previewPrefix(binding)}${location.pathname.slice(internalPrefix.length)}${location.search}${location.hash}`
            }
          } catch {}
        }
        if (responseHeaders['set-cookie']) {
          const prefix = this.previewPrefix(binding)
          responseHeaders['set-cookie'] = (Array.isArray(responseHeaders['set-cookie']) ? responseHeaders['set-cookie'] : [responseHeaders['set-cookie']]).map((cookie) => {
            const withoutDomain = cookie.replace(/;\s*Domain=[^;]*/ig, '')
            if (/;\s*Path=/i.test(withoutDomain)) return withoutDomain.replace(/;\s*Path=[^;]*/i, `; Path=${prefix}/`)
            return `${withoutDomain}; Path=${prefix}/`
          })
        }

        const contentType = String(upstreamResponse.headers['content-type'] || '')
        if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
          upstreamResponse.pipe(response)
          upstreamResponse.once('end', resolve)
          upstreamResponse.once('error', reject)
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        upstreamResponse.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_HTML_BYTES) {
            upstreamResponse.destroy(new Error('Browser preview HTML exceeds the 20 MiB limit'))
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        upstreamResponse.once('error', reject)
        upstreamResponse.once('end', () => {
          const body = Buffer.from(this.rewriteUpstreamText(Buffer.concat(chunks).toString('utf8'), binding))
          responseHeaders['content-length'] = String(body.length)
          response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders)
          response.end(body, resolve)
        })
      })
      request.pipe(upstreamRequest)
    })
  }

  private proxyEventsWebSocket(request: IncomingMessage, socket: Socket, head: Buffer, binding: GatewayBinding): void {
    this.sockets.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(binding.eventsUrl, {
        headers: { Origin: this.upstreamOrigin },
        maxPayload: 1024 * 1024,
      })
      this.bridgeSockets(client, upstream, (data, isBinary) => this.rewriteGatewayMessage(data, isBinary, binding))
    })
  }

  private proxyPreviewWebSocket(request: IncomingMessage, socket: Socket, head: Buffer, binding: GatewayBinding, upstreamUrl: URL): void {
    this.sockets.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(upstreamUrl, {
        headers: { Origin: this.upstreamOrigin },
        maxPayload: 1024 * 1024,
      })
      this.bridgeSockets(client, upstream)
    })
  }

  private rewriteGatewayMessage(data: RawData, isBinary: boolean, binding: GatewayBinding): { data: RawData; binary: boolean } {
    if (isBinary) return { data, binary: isBinary }
    const value = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8')
    this.syncAgentState(value, binding)
    if (!binding.previewUrl) return { data, binary: false }
    return { data: Buffer.from(this.rewriteUpstreamText(value, binding)), binary: false }
  }

  /** Keep the gateway binding aligned with Browser Host's sliding session TTL. */
  private syncAgentState(raw: string, binding: GatewayBinding): void {
    try {
      const message = JSON.parse(raw) as Record<string, unknown>
      const candidate = message.type === 'snapshot'
        ? message.payload
        : message.type === 'event' && (message.payload as Record<string, unknown> | undefined)?.event
          ? ((message.payload as Record<string, unknown>).event as Record<string, unknown>).type === 'session.state'
            ? ((message.payload as Record<string, unknown>).event as Record<string, unknown>).state
            : undefined
          : undefined
      if (!candidate || typeof candidate !== 'object') return
      const state = candidate as BrowserAgentSession['state']
      if (state.id !== binding.sessionId || typeof state.expiresAt !== 'string') return
      binding.agentSession.state = state
      const expiresAt = Date.parse(state.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= binding.expiresAt) return
      binding.expiresAt = expiresAt
      clearTimeout(binding.cleanupTimer)
      binding.cleanupTimer = setTimeout(() => this.unregister(binding.sessionId), Math.max(1_000, expiresAt - Date.now()))
      binding.cleanupTimer.unref()
    } catch {
      // Non-JSON screencast/control frames are forwarded unchanged.
    }
  }

  private bridgeSockets(
    client: WebSocket,
    upstream: WebSocket,
    transform: (data: RawData, isBinary: boolean) => { data: RawData; binary: boolean } = (data, isBinary) => ({ data, binary: isBinary }),
  ): void {
    let closed = false
    const pending: Array<{ data: Parameters<WebSocket['send']>[0]; binary: boolean }> = []
    const closeBoth = (code = 1000, reason = 'Gateway closed') => {
      if (closed) return
      closed = true
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
      else if (client.readyState === WebSocket.CONNECTING) client.terminate()
      if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason)
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
    }
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        if (pending.length < 128) pending.push({ data, binary: isBinary })
        return
      }
      if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return
      upstream.send(data, { binary: isBinary })
    })
    upstream.on('message', (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return
      const transformed = transform(data, isBinary)
      client.send(transformed.data, { binary: transformed.binary })
    })
    client.once('close', () => closeBoth())
    upstream.once('close', () => closeBoth())
    client.once('error', () => closeBoth(1011, 'Gateway client transport failed'))
    upstream.once('error', () => closeBoth(1011, 'Browser Host transport failed'))
    upstream.once('open', () => {
      for (const message of pending.splice(0)) {
        if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) break
        upstream.send(message.data, { binary: message.binary })
      }
    })
  }
}
