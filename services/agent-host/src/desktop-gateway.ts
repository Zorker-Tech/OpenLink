import { randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { AgentHostError } from './errors.js'

const DESKTOP_SESSION_TTL_MS = 8 * 60 * 60 * 1_000
const MAX_SOCKET_BUFFER_BYTES = 64 * 1024 * 1024

export interface DesktopEndpoint {
  url: string
  headers?: Record<string, string>
}

export interface DesktopSessionIdentity {
  ownerId: string
  workspaceId: string
  projectId: string
  sessionId: string
}

interface DesktopBinding extends DesktopSessionIdentity {
  token: string
  upstream: URL
  upstreamHeaders: Record<string, string>
  expiresAt: number
  cleanupTimer: NodeJS.Timeout
  clients: Set<WebSocket>
  onActivity?: () => void
}

export interface DesktopGatewayConfig {
  /** URL reachable by the user's browser, not the Project VM loopback URL. */
  publicBaseUrl: string
  /** Origins allowed to open desktop transport and WebSocket connections. */
  allowedOrigins: string[]
}

export interface PublicDesktopSession {
  desktopUrl: string
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function safeTokenEquals(left: string | undefined, right: string): boolean {
  if (!left) return false
  const supplied = Buffer.from(left)
  const expected = Buffer.from(right)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function closeSocket(socket: Duplex, status: number, message: string): void {
  const reason = message.replace(/[\r\n]/g, ' ').slice(0, 160)
  try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`) } finally { socket.destroy() }
}

function normalizedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\u0000]/.test(value)) continue
    result[name.toLowerCase()] = value
  }
  return result
}

/**
 * Public VNC edge for one Agent Worker OpenSandbox workload.
 * OpenSandbox endpoint credentials stay on Agent Host; the browser receives
 * only a random, session-scoped capability in the gateway path.
 */
export class DesktopGateway {
  private readonly publicBaseUrl: string
  private readonly allowedOrigins: Set<string>
  private readonly bindings = new Map<string, DesktopBinding>()
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_BUFFER_BYTES })

  constructor(config: DesktopGatewayConfig) {
    const base = new URL(config.publicBaseUrl)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('Desktop gateway public URL must use HTTP or HTTPS')
    this.publicBaseUrl = stripTrailingSlash(base.toString())
    // Keep opaque-origin clients compatible. The random session capability is
    // still required for these requests, including the desktop canvas client.
    this.allowedOrigins = new Set([...config.allowedOrigins.map((origin) => origin.trim()).filter(Boolean), base.origin, 'null'])
    if (!this.allowedOrigins.size) throw new Error('Desktop gateway requires at least one allowed origin')
  }

  register(identity: DesktopSessionIdentity, endpoint: DesktopEndpoint, onActivity?: () => void): PublicDesktopSession {
    const existing = this.bindings.get(identity.sessionId)
    if (existing && existing.expiresAt > Date.now()
      && existing.ownerId === identity.ownerId
      && existing.workspaceId === identity.workspaceId
      && existing.projectId === identity.projectId
      && existing.upstream.toString() === new URL(endpoint.url).toString()) {
      existing.upstreamHeaders = normalizedHeaders(endpoint.headers)
      existing.onActivity = onActivity
      this.touch(existing)
      return { desktopUrl: this.desktopUrl(existing) }
    }
    this.unregister(identity.sessionId)

    const upstream = new URL(endpoint.url)
    if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') throw new Error('Desktop gateway upstream URL must use HTTP or HTTPS')
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + DESKTOP_SESSION_TTL_MS
    const cleanupTimer = setTimeout(() => this.unregister(identity.sessionId), DESKTOP_SESSION_TTL_MS)
    cleanupTimer.unref()
    const binding: DesktopBinding = {
      ...identity,
      token,
      upstream,
      upstreamHeaders: normalizedHeaders(endpoint.headers),
      expiresAt,
      cleanupTimer,
      clients: new Set(),
      onActivity,
    }
    this.bindings.set(binding.sessionId, binding)
    return { desktopUrl: this.desktopUrl(binding) }
  }

  unregister(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding) return
    clearTimeout(binding.cleanupTimer)
    this.bindings.delete(sessionId)
    for (const client of binding.clients) client.terminate()
    binding.clients.clear()
  }

  hasActiveConnection(sessionId: string): boolean {
    const binding = this.bindings.get(sessionId)
    return Boolean(binding && binding.clients.size > 0)
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const external = new URL(request.url || '/', this.publicBaseUrl)
      const { binding, suffix } = this.resolveRoute(external.pathname)
      this.authorize(external, binding)
      this.assertOrigin(request, false)
      this.touch(binding)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Cache-Control': 'no-store', ...this.opaqueOriginCorsHeaders(request) })
        response.end()
        return
      }
      const upstream = this.upstreamUrl(binding, suffix, external)
      await this.proxyHttp(request, response, binding, upstream)
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(error instanceof AgentHostError && error.code === 'AUTH_DENIED' ? 401 : 404, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          'Referrer-Policy': 'no-referrer',
        })
        response.end('Desktop session is unavailable')
      }
    }
  }

  handleUpgrade(request: IncomingMessage, rawSocket: Duplex, head: Buffer): boolean {
    const socket = rawSocket as Socket
    let binding: DesktopBinding
    let upstream: URL
    try {
      const external = new URL(request.url || '/', this.publicBaseUrl)
      const route = this.resolveRoute(external.pathname)
      binding = route.binding
      this.authorize(external, binding)
      this.assertOrigin(request, true)
      this.touch(binding)
      upstream = this.upstreamUrl(binding, route.suffix, external)
    } catch (error) {
      const pathname = (() => { try { return new URL(request.url || '/', this.publicBaseUrl).pathname } catch { return '' } })()
      if (!pathname.startsWith('/v1/desktop/gateway/sessions/')) return false
      closeSocket(socket, 401, error instanceof Error ? error.message : 'Desktop gateway authorization failed')
      return true
    }

    this.sockets.handleUpgrade(request, socket, head, (client) => {
      binding.clients.add(client)
      const upstreamSocket = new WebSocket(upstream.toString().replace(/^http/, 'ws'), {
        headers: { ...binding.upstreamHeaders, Origin: upstream.origin },
        maxPayload: MAX_SOCKET_BUFFER_BYTES,
      })
      this.bridgeSockets(client, upstreamSocket, binding)
    })
    return true
  }

  close(): void {
    for (const sessionId of this.bindings.keys()) this.unregister(sessionId)
    for (const client of this.sockets.clients) client.terminate()
    this.sockets.close()
  }

  private desktopPrefix(binding: DesktopBinding): string {
    return `/v1/desktop/gateway/sessions/${encodeURIComponent(binding.sessionId)}/${binding.token}/desktop`
  }

  private desktopUrl(binding: DesktopBinding): string {
    const origin = new URL(this.publicBaseUrl)
    const prefix = this.desktopPrefix(binding)
    const page = new URL(`${this.publicBaseUrl}${prefix}/vnc.html`)
    page.searchParams.set('autoconnect', 'true')
    page.searchParams.set('reconnect', 'true')
    page.searchParams.set('resize', 'remote')
    page.searchParams.set('host', origin.hostname)
    page.searchParams.set('port', origin.port || (origin.protocol === 'https:' ? '443' : '80'))
    page.searchParams.set('path', prefix.slice(1))
    return page.toString()
  }

  private resolveRoute(pathname: string): { binding: DesktopBinding; suffix: string } {
    const match = /^\/v1\/desktop\/gateway\/sessions\/([^/]+)\/([^/]+)\/desktop(?:\/|$)/.exec(pathname)
    if (!match) throw new Error('Desktop gateway route is invalid')
    const sessionId = decodeURIComponent(match[1]!)
    const binding = this.requireBinding(sessionId)
    if (!safeTokenEquals(match[2], binding.token)) throw new AgentHostError('AUTH_DENIED', 'Desktop gateway capability is invalid')
    const prefix = this.desktopPrefix(binding)
    if (pathname === prefix) return { binding, suffix: '/' }
    if (!pathname.startsWith(`${prefix}/`)) throw new Error('Desktop gateway path is invalid')
    return { binding, suffix: pathname.slice(prefix.length) || '/' }
  }

  private requireBinding(sessionId: string): DesktopBinding {
    const binding = this.bindings.get(sessionId)
    if (!binding || binding.expiresAt <= Date.now()) {
      this.unregister(sessionId)
      throw new AgentHostError('BROWSER_SESSION_FAILED', 'Desktop gateway binding is no longer available', { retryable: true })
    }
    return binding
  }

  private authorize(external: URL, binding: DesktopBinding): void {
    const match = /^\/v1\/desktop\/gateway\/sessions\/[^/]+\/([^/]+)\/desktop(?:\/|$)/.exec(external.pathname)
    if (!safeTokenEquals(match?.[1], binding.token)) throw new AgentHostError('AUTH_DENIED', 'Desktop gateway capability is invalid')
  }

  private assertOrigin(request: IncomingMessage, required: boolean): void {
    const origin = request.headers.origin
    if (origin && !this.allowedOrigins.has(origin)) throw new AgentHostError('AUTH_DENIED', 'Desktop gateway origin is not allowed')
    if (required && !origin) throw new AgentHostError('AUTH_DENIED', 'Desktop gateway origin is required')
  }

  private opaqueOriginCorsHeaders(request: IncomingMessage): Record<string, string> {
    if (request.headers.origin !== 'null') return {}
    return {
      'access-control-allow-origin': 'null',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '600',
      vary: 'Origin',
    }
  }

  private touch(binding: DesktopBinding): void {
    binding.onActivity?.()
    binding.expiresAt = Date.now() + DESKTOP_SESSION_TTL_MS
    clearTimeout(binding.cleanupTimer)
    binding.cleanupTimer = setTimeout(() => this.unregister(binding.sessionId), DESKTOP_SESSION_TTL_MS)
    binding.cleanupTimer.unref()
  }

  private upstreamUrl(binding: DesktopBinding, suffix: string, external: URL): URL {
    const upstream = new URL(binding.upstream.toString())
    const basePath = upstream.pathname.replace(/\/+$/, '')
    upstream.pathname = suffix === '/' ? basePath : `${basePath}${suffix}`
    upstream.search = external.search
    upstream.searchParams.delete('token')
    return upstream
  }

  private async proxyHttp(request: IncomingMessage, response: ServerResponse, binding: DesktopBinding, upstream: URL): Promise<void> {
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: upstream.host, 'accept-encoding': 'identity' }
    delete headers.authorization
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    delete headers.cookie
    delete headers.referer
    delete headers.origin
    for (const [name, value] of Object.entries(binding.upstreamHeaders)) headers[name] = value

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
      upstreamRequest.once('timeout', () => upstreamRequest.destroy(new Error('Desktop upstream timed out')))
      upstreamRequest.once('response', (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers }
        delete responseHeaders['x-frame-options']
        delete responseHeaders['content-length']
        delete responseHeaders['content-encoding']
        delete responseHeaders['transfer-encoding']
        delete responseHeaders['set-cookie']
        responseHeaders['referrer-policy'] = 'no-referrer'
        Object.assign(responseHeaders, this.opaqueOriginCorsHeaders(request))
        if (typeof responseHeaders.location === 'string') {
          try {
            const location = new URL(responseHeaders.location, upstream)
            if (location.origin === upstream.origin) {
              const basePath = binding.upstream.pathname.replace(/\/+$/, '')
              const suffix = location.pathname.startsWith(basePath)
                ? location.pathname.slice(basePath.length)
                : location.pathname
              responseHeaders.location = `${this.desktopPrefix(binding)}${suffix.startsWith('/') ? suffix : `/${suffix}`}${location.search}${location.hash}`
            }
          } catch {}
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(response)
        upstreamResponse.once('end', resolve)
        upstreamResponse.once('error', reject)
      })
      request.pipe(upstreamRequest)
    })
  }

  private bridgeSockets(client: WebSocket, upstream: WebSocket, binding: DesktopBinding): void {
    let closed = false
    const pending: Array<{ data: Parameters<WebSocket['send']>[0]; binary: boolean }> = []
    const closeBoth = (code = 1000, reason = 'Desktop gateway closed') => {
      if (closed) return
      closed = true
      binding.clients.delete(client)
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
      else if (client.readyState === WebSocket.CONNECTING) client.terminate()
      if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason)
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
    }
    client.on('message', (data, isBinary) => {
      this.touch(binding)
      if (upstream.readyState === WebSocket.CONNECTING) {
        if (pending.length < 128) pending.push({ data, binary: isBinary })
        return
      }
      if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return
      upstream.send(data, { binary: isBinary })
    })
    upstream.on('message', (data, isBinary) => {
      this.touch(binding)
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return
      client.send(data, { binary: isBinary })
    })
    client.once('close', () => closeBoth())
    upstream.once('close', () => closeBoth())
    client.once('error', () => closeBoth(1011, 'Desktop browser transport failed'))
    upstream.once('error', () => closeBoth(1011, 'Desktop sandbox transport failed'))
    upstream.once('open', () => {
      for (const message of pending.splice(0)) {
        if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) break
        upstream.send(message.data, { binary: message.binary })
      }
    })
  }
}
