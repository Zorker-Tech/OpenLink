import { randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { AgentHostError } from './errors.js'

const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024
const COOKIE_PREFIX = 'openlink_code_server_gateway_'

interface CodeServerBinding {
  sessionId: string
  token: string
  ownerId: string
  workspaceId: string
  projectId: string
  upstream: URL
  expiresAt: number
  cleanupTimer: NodeJS.Timeout
}

export interface CodeServerGatewayConfig {
  publicBaseUrl: string
  allowedOrigins: string[]
}

export interface PublicCodeServerSession {
  sessionId: string
  url: string
  expiresAt: string
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

function tokenEquals(value: string | undefined, expected: string): boolean {
  if (!value) return false
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function closeSocket(socket: Duplex, status: number, message: string): void {
  const reason = message.replace(/[\r\n]/g, ' ').slice(0, 160)
  try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`) } finally { socket.destroy() }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function loopbackAliases(origin: string): string[] {
  const url = new URL(origin)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return [url.origin]
  return ['localhost', '127.0.0.1', '[::1]'].map((hostname) => {
    const alias = new URL(url)
    alias.hostname = hostname
    return alias.origin
  })
}

/**
 * Authenticated HTTP/WebSocket edge for a project-scoped code-server.
 *
 * The editor never receives the Project VM endpoint or an Agent Host API
 * token. A short-lived bootstrap URL exchanges its one-time query token for
 * an HttpOnly, path-scoped cookie; all subsequent HTTP and WebSocket traffic
 * is authorized by this binding and proxied to the VM-local code-server.
 */
export class CodeServerGateway {
  private readonly publicBaseUrl: string
  private readonly allowedOrigins: Set<string>
  private readonly bindings = new Map<string, CodeServerBinding>()
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })

  constructor(config: CodeServerGatewayConfig) {
    const base = new URL(config.publicBaseUrl)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('Code-server gateway public URL must use HTTP or HTTPS')
    this.publicBaseUrl = stripTrailingSlash(base.toString())
    // The Local stack permits localhost and 127.0.0.1. A code iframe is
    // same-site only when the gateway follows the app hostname, so accept all
    // loopback aliases for the gateway's own WebSocket origin as well.
    this.allowedOrigins = new Set([...config.allowedOrigins, ...loopbackAliases(base.origin)].map((origin) => origin.trim()).filter(Boolean))
    if (!this.allowedOrigins.size) throw new Error('Code-server gateway requires at least one allowed origin')
  }

  create(input: { ownerId: string; workspaceId: string; projectId: string; upstream: string; ttlMs?: number }): PublicCodeServerSession {
    const sessionId = randomBytes(18).toString('base64url')
    const token = randomBytes(32).toString('base64url')
    const upstream = new URL(input.upstream)
    if (!['http:', 'https:'].includes(upstream.protocol)) throw new AgentHostError('PROVISIONING_FAILED', 'Code-server endpoint protocol is invalid')
    const expiresAt = Date.now() + Math.max(60_000, Math.min(input.ttlMs ?? 30 * 60_000, 24 * 60 * 60_000))
    const cleanupTimer = setTimeout(() => this.unregister(sessionId), expiresAt - Date.now())
    cleanupTimer.unref()
    this.bindings.set(sessionId, { sessionId, token, ownerId: input.ownerId, workspaceId: input.workspaceId, projectId: input.projectId, upstream, expiresAt, cleanupTimer })
    return { sessionId, url: this.url(sessionId, token, true), expiresAt: new Date(expiresAt).toISOString() }
  }

  unregister(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding) return
    clearTimeout(binding.cleanupTimer)
    this.bindings.delete(sessionId)
  }

  getIdentity(sessionId: string): { ownerId: string; workspaceId: string; projectId: string } {
    const binding = this.requireBinding(sessionId)
    return { ownerId: binding.ownerId, workspaceId: binding.workspaceId, projectId: binding.projectId }
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
    const binding = this.requireBinding(sessionId)
    this.assertOrigin(request)
    const external = new URL(request.url || '/', this.publicBaseUrl)
    const prefix = this.prefix(sessionId)
    const suffix = external.pathname === prefix ? '/' : external.pathname.startsWith(`${prefix}/`) ? external.pathname.slice(prefix.length) || '/' : null
    if (!suffix) throw new AgentHostError('INVALID_BODY', 'Code-server gateway path is invalid')
    if (suffix === '/__openlink_bootstrap') {
      this.authorize(external.searchParams.get('token'), undefined, binding)
      const secure = new URL(this.publicBaseUrl).protocol === 'https:' ? '; Secure' : ''
      response.setHeader('Set-Cookie', `${cookieName(sessionId)}=${encodeURIComponent(binding.token)}; HttpOnly; SameSite=Strict; Path=${prefix}/${secure}`)
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.writeHead(302, { Location: `${prefix}/` })
      response.end()
      return
    }
    this.authorize(external.searchParams.get('token'), request.headers.cookie, binding)
    const upstream = new URL(binding.upstream.toString())
    upstream.pathname = suffix
    upstream.search = external.search
    upstream.searchParams.delete('token')
    await this.proxyHttp(request, response, binding, upstream)
  }

  /**
   * Handles only code-server gateway upgrades. Returning false lets the
   * shared Agent Host upgrade listener dispatch Browser Host sockets to their
   * own gateway instead of destroying them as unknown editor traffic.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    try {
      const external = new URL(request.url || '/', this.publicBaseUrl)
      const match = /^\/v1\/code-server\/gateway\/sessions\/([^/]+)(?:\/|$)/.exec(external.pathname)
      if (!match) return false
      const binding = this.requireBinding(decodeURIComponent(match[1]!))
      this.assertOrigin(request)
      this.authorize(external.searchParams.get('token'), request.headers.cookie, binding)
      const prefix = this.prefix(binding.sessionId)
      const suffix = external.pathname === prefix ? '/' : external.pathname.slice(prefix.length) || '/'
      const upstream = new URL(binding.upstream.toString())
      upstream.pathname = suffix
      upstream.search = external.search
      upstream.searchParams.delete('token')
      this.sockets.handleUpgrade(request, socket as Socket, head, (client) => {
        const target = upstream.toString().replace(/^http/, 'ws')
        // code-server validates the WebSocket Origin against its own HTTP
        // listener. The public gateway origin is intentionally different
        // from that VM-local listener, so forwarding it makes code-server
        // return 403 after the client has already been upgraded. The upstream
        // is never browser-reachable; send its own origin for this internal
        // hop while retaining the public-origin validation above.
        const upstreamSocket = new WebSocket(target, { headers: { Origin: upstream.origin }, maxPayload: 2 * 1024 * 1024 })
        this.bridge(client, upstreamSocket)
      })
      return true
    } catch (error) {
      closeSocket(socket, 401, error instanceof Error ? error.message : 'Code-server gateway authorization failed')
      return true
    }
  }

  close(): void {
    for (const binding of this.bindings.values()) clearTimeout(binding.cleanupTimer)
    this.bindings.clear()
    for (const client of this.sockets.clients) client.terminate()
    this.sockets.close()
  }

  private prefix(sessionId: string): string {
    return `/v1/code-server/gateway/sessions/${encodeURIComponent(sessionId)}`
  }

  private url(sessionId: string, token: string, bootstrap: boolean): string {
    const suffix = bootstrap ? '/__openlink_bootstrap' : '/'
    return `${this.publicBaseUrl}${this.prefix(sessionId)}${suffix}?token=${encodeURIComponent(token)}`
  }

  private requireBinding(sessionId: string): CodeServerBinding {
    const binding = this.bindings.get(sessionId)
    if (!binding || binding.expiresAt <= Date.now()) {
      this.unregister(sessionId)
      throw new AgentHostError('BROWSER_SESSION_FAILED', 'Code-server gateway binding is no longer available', { retryable: true })
    }
    return binding
  }

  private assertOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin
    if (origin && !this.allowedOrigins.has(origin)) throw new AgentHostError('AUTH_DENIED', 'Code-server gateway origin is not allowed')
  }

  private authorize(queryToken: string | null | undefined, cookieHeader: string | undefined, binding: CodeServerBinding): void {
    const cookie = parseCookies(cookieHeader).get(cookieName(binding.sessionId))
    if (!tokenEquals(queryToken ?? undefined, binding.token) && !tokenEquals(cookie, binding.token)) throw new AgentHostError('AUTH_DENIED', 'Code-server gateway token is invalid')
  }

  private async proxyHttp(request: IncomingMessage, response: ServerResponse, binding: CodeServerBinding, upstream: URL): Promise<void> {
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: upstream.host, 'accept-encoding': 'identity' }
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
    const impl = upstream.protocol === 'https:' ? httpsRequest : httpRequest
    const upstreamRequest = impl({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: request.method, path: `${upstream.pathname}${upstream.search}`, headers, timeout: 30_000 })
    await new Promise<void>((resolve, reject) => {
      upstreamRequest.once('error', reject)
      upstreamRequest.once('timeout', () => upstreamRequest.destroy(new Error('Code-server upstream timed out')))
      upstreamRequest.once('response', (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers }
        delete responseHeaders['content-length']
        delete responseHeaders['content-encoding']
        delete responseHeaders['transfer-encoding']
        delete responseHeaders['x-frame-options']
        const frameAncestors = [...this.allowedOrigins].join(' ')
        // code-server commonly sends `frame-ancestors 'self'`; appending a
        // second directive does not override it. Replace the upstream rule so
        // the explicitly configured OpenLink application origins can embed
        // the workbench without weakening other CSP directives.
        const csp = String(responseHeaders['content-security-policy'] || '')
          .replace(/(?:^|;)\s*frame-ancestors\s+[^;]*/ig, '')
          .replace(/^\s*;\s*|\s*;\s*$/g, '')
        responseHeaders['content-security-policy'] = csp ? `${csp}; frame-ancestors ${frameAncestors}` : `frame-ancestors ${frameAncestors}`
        if (typeof responseHeaders.location === 'string' && responseHeaders.location.startsWith('/')) responseHeaders.location = `${this.prefix(binding.sessionId)}${responseHeaders.location}`
        if (responseHeaders['set-cookie']) {
          const prefix = this.prefix(binding.sessionId)
          responseHeaders['set-cookie'] = (Array.isArray(responseHeaders['set-cookie']) ? responseHeaders['set-cookie'] : [responseHeaders['set-cookie']]).map((value) => {
            const cookie = value.replace(/;\s*Domain=[^;]*/ig, '')
            return /;\s*Path=/i.test(cookie) ? cookie.replace(/;\s*Path=[^;]*/i, `; Path=${prefix}/`) : `${cookie}; Path=${prefix}/`
          })
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(response)
        upstreamResponse.once('end', resolve)
        upstreamResponse.once('error', reject)
      })
      request.pipe(upstreamRequest)
    })
  }

  private bridge(client: WebSocket, upstream: WebSocket): void {
    let closed = false
    // VS Code sends its remote-authority greeting immediately after the
    // gateway completes the client-side HTTP upgrade. The upstream socket is
    // still connecting at that point. Retaining these initial frames is
    // essential: dropping them leaves the workbench rendered but unable to
    // mount its /workspace filesystem.
    const pending: Array<{ data: Parameters<WebSocket['send']>[0]; binary: boolean }> = []
    const closeBoth = (code = 1000, reason = 'Code-server gateway closed') => {
      if (closed) return
      closed = true
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
      else if (client.readyState === WebSocket.CONNECTING) client.terminate()
      if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason)
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
    }
    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        if (pending.length < 128) pending.push({ data, binary })
        return
      }
      if (upstream.readyState === WebSocket.OPEN && upstream.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) upstream.send(data, { binary })
    })
    upstream.on('message', (data, binary) => {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) client.send(data, { binary })
    })
    client.once('close', () => closeBoth())
    upstream.once('close', () => closeBoth())
    client.once('error', () => closeBoth(1011, 'Code-server client transport failed'))
    upstream.once('error', () => closeBoth(1011, 'Code-server upstream transport failed'))
    upstream.once('open', () => {
      for (const message of pending.splice(0)) {
        if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) break
        upstream.send(message.data, { binary: message.binary })
      }
    })
  }
}
