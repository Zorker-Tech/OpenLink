import { randomBytes } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import httpProxy from 'http-proxy'
import type { BrowserTokenService } from './auth.js'
import { BrowserHostError } from './errors.js'
import { INSPECTOR_BRIDGE_SOURCE } from './inspector-bridge.js'
import type { NativePreviewRuntime } from './preview-runtime.js'

const MAX_HTML_BYTES = 20 * 1024 * 1024

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=')
    if (index > 0) cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()))
  }
  return cookies
}

function cookieName(sessionId: string): string {
  return `openlink_preview_${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function encodeOrigins(origins: string[]): string {
  return Buffer.from(JSON.stringify(origins)).toString('base64')
}

function addPreviewPolicyToCsp(value: string | string[] | undefined, runtime: NativePreviewRuntime): string | string[] | undefined {
  const patch = (policy: string) => {
    const directives = policy.split(';').map((part) => part.trim()).filter(Boolean)
    const index = directives.findIndex((part) => part === 'script-src' || part.startsWith('script-src '))
    const nonceSource = `'nonce-${runtime.bridgeNonce}'`
    if (index < 0) directives.push(`script-src 'self' ${nonceSource}`)
    else {
      directives[index] = directives[index].replace(/\s+'none'(?=\s|$)/g, '')
      if (!/(?:^|\s)'self'(?:\s|$)/.test(directives[index])) directives[index] += " 'self'"
      if (!directives[index].includes(nonceSource)) directives[index] += ` ${nonceSource}`
    }
    const ancestors = `frame-ancestors ${runtime.parentOrigins.join(' ')}`
    const ancestorIndex = directives.findIndex((part) => part === 'frame-ancestors' || part.startsWith('frame-ancestors '))
    if (ancestorIndex < 0) directives.push(ancestors)
    else directives[ancestorIndex] = ancestors
    return directives.join('; ')
  }
  if (!value) return patch('')
  return Array.isArray(value) ? value.map(patch) : patch(value)
}

function injectBridge(html: string, runtime: NativePreviewRuntime): string {
  const tag = `<script nonce="${escapeHtmlAttribute(runtime.bridgeNonce)}" src="/v1/browser/inspector-bridge.js" data-openlink-session="${escapeHtmlAttribute(runtime.sessionId)}" data-openlink-nonce="${escapeHtmlAttribute(runtime.bridgeNonce)}" data-openlink-origins="${escapeHtmlAttribute(encodeOrigins(runtime.parentOrigins))}"></script>`
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(html)
  if (headOpen?.index !== undefined) {
    const insertAt = headOpen.index + headOpen[0].length
    return `${html.slice(0, insertAt)}${tag}${html.slice(insertAt)}`
  }
  const body = html.search(/<body(?:\s|>)/i)
  if (body >= 0) return `${html.slice(0, body)}${tag}${html.slice(body)}`
  return `${tag}${html}`
}

function rewriteSetCookie(value: string | string[] | undefined, publicPath: string): string[] | undefined {
  if (!value) return undefined
  return (Array.isArray(value) ? value : [value]).map((cookie) => {
    const withoutDomain = cookie.replace(/;\s*Domain=[^;]*/ig, '')
    if (/;\s*Path=/i.test(withoutDomain)) return withoutDomain.replace(/;\s*Path=[^;]*/i, `; Path=${publicPath}/`)
    return `${withoutDomain}; Path=${publicPath}/`
  })
}

export class NativePreviewProxy {
  private readonly websocketProxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: false, secure: true })

  constructor(
    private readonly tokens: BrowserTokenService,
    private readonly publicBaseUrl: string,
    private readonly resolveRuntime: (sessionId: string) => NativePreviewRuntime | undefined,
  ) {}

  serveBridge(response: ServerResponse): void {
    response.writeHead(200, {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(INSPECTOR_BRIDGE_SOURCE)
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
    const runtime = this.resolveRuntime(sessionId)
    if (!runtime) throw new BrowserHostError('SESSION_NOT_FOUND', 'Preview session not found', 404)
    const url = new URL(request.url || '/', this.publicBaseUrl)
    const token = url.searchParams.get('token') || parseCookies(request.headers.cookie).get(cookieName(sessionId))
    if (!token) throw new BrowserHostError('PREVIEW_AUTH_REQUIRED', 'Preview capability is required', 401)
    this.tokens.verify(token, 'preview', sessionId)
    url.searchParams.delete('token')

    if (url.pathname === `${runtime.publicPath}/__openlink_bootstrap`) {
      const secure = new URL(this.publicBaseUrl).protocol === 'https:' ? '; Secure' : ''
      response.setHeader('Set-Cookie', `${cookieName(sessionId)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=${runtime.publicPath}/${secure}`)
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.writeHead(302, { Location: `${runtime.publicPath}/` })
      response.end()
      return
    }

    await this.proxyHttp(request, response, runtime, url)
  }

  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer, sessionId: string): void {
    const runtime = this.resolveRuntime(sessionId)
    if (!runtime) throw new BrowserHostError('SESSION_NOT_FOUND', 'Preview session not found', 404)
    if (!request.headers.origin || !runtime.allowedSocketOrigins.includes(request.headers.origin)) {
      throw new BrowserHostError('ORIGIN_DENIED', 'Preview WebSocket origin is not allowed', 403)
    }
    const url = new URL(request.url || '/', this.publicBaseUrl)
    const token = url.searchParams.get('token') || parseCookies(request.headers.cookie).get(cookieName(sessionId))
    if (!token) throw new BrowserHostError('PREVIEW_AUTH_REQUIRED', 'Preview capability is required', 401)
    this.tokens.verify(token, 'preview', sessionId)
    url.searchParams.delete('token')
    request.url = this.upstreamPath(runtime, url)
    request.headers.host = runtime.target.host
    request.headers.origin = runtime.target.origin
    for (const [name, value] of Object.entries(runtime.targetHeaders)) request.headers[name.toLowerCase()] = value
    const upstreamCookies = [...parseCookies(request.headers.cookie).entries()]
      .filter(([name]) => name !== cookieName(runtime.sessionId))
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ')
    if (upstreamCookies) request.headers.cookie = upstreamCookies
    else delete request.headers.cookie
    this.websocketProxy.ws(request, socket, head, { target: runtime.target.origin })
  }

  close(): void {
    this.websocketProxy.close()
  }

  private async proxyHttp(request: IncomingMessage, response: ServerResponse, runtime: NativePreviewRuntime, url: URL): Promise<void> {
    const target = runtime.target
    const headers = { ...request.headers }
    headers.host = target.host
    headers['accept-encoding'] = 'identity'
    if (headers.origin) headers.origin = target.origin
    Object.assign(headers, runtime.targetHeaders)
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upstreamCookies = [...parseCookies(request.headers.cookie).entries()]
      .filter(([name]) => name !== cookieName(runtime.sessionId))
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ')
    if (upstreamCookies) headers.cookie = upstreamCookies
    else delete headers.cookie

    const upstreamRequest = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: this.upstreamPath(runtime, url),
      headers,
      timeout: 30_000,
    })

    await new Promise<void>((resolve, reject) => {
      upstreamRequest.once('error', reject)
      upstreamRequest.once('timeout', () => upstreamRequest.destroy(new BrowserHostError('PREVIEW_UPSTREAM_TIMEOUT', 'Preview upstream timed out', 504, true)))
      upstreamRequest.once('response', (upstream) => {
        const responseHeaders = { ...upstream.headers }
        delete responseHeaders['content-length']
        delete responseHeaders['content-encoding']
        delete responseHeaders['transfer-encoding']
        delete responseHeaders['x-frame-options']
        const csp = addPreviewPolicyToCsp(responseHeaders['content-security-policy'], runtime)
        if (csp) responseHeaders['content-security-policy'] = csp
        else delete responseHeaders['content-security-policy']
        const setCookie = rewriteSetCookie(responseHeaders['set-cookie'], runtime.publicPath)
        if (setCookie) responseHeaders['set-cookie'] = setCookie
        else delete responseHeaders['set-cookie']
        if (typeof responseHeaders.location === 'string') {
          try {
            const location = new URL(responseHeaders.location, target)
            if (location.origin === target.origin) responseHeaders.location = `${runtime.publicPath}${location.pathname}${location.search}${location.hash}`
          } catch {}
        }

        const contentType = String(upstream.headers['content-type'] || '')
        if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
          response.writeHead(upstream.statusCode ?? 502, responseHeaders)
          upstream.pipe(response)
          upstream.once('end', resolve)
          upstream.once('error', reject)
          return
        }

        const chunks: Buffer[] = []
        let size = 0
        upstream.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_HTML_BYTES) {
            upstream.destroy(new BrowserHostError('PREVIEW_HTML_TOO_LARGE', 'Preview HTML exceeds the 20 MiB limit', 502))
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        upstream.once('error', reject)
        upstream.once('end', () => {
          const html = injectBridge(Buffer.concat(chunks).toString('utf8'), runtime)
          const body = Buffer.from(html)
          responseHeaders['content-length'] = String(body.length)
          response.writeHead(upstream.statusCode ?? 200, responseHeaders)
          response.end(body, resolve)
        })
      })
      request.pipe(upstreamRequest)
    })
  }

  private upstreamPath(runtime: NativePreviewRuntime, url: URL): string {
    if (!url.pathname.startsWith(`${runtime.publicPath}/`)) throw new BrowserHostError('INVALID_PREVIEW_PATH', 'Preview path is outside the session', 404)
    const path = runtime.pathMode === 'preserve-session-prefix'
      ? url.pathname
      : `/${url.pathname.slice(runtime.publicPath.length).replace(/^\/+/, '')}`
    return `${path}${url.search}`
  }
}
