import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function contentType(pathname) {
  return MIME_TYPES[extname(pathname).toLowerCase()] || 'application/octet-stream'
}

function isPathInside(root, candidate) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + sep)
}

/**
 * Strip attributes that bind a cookie to the upstream origin. The browser must
 * store the session against the loopback gateway origin instead. The cookie
 * name is intentionally preserved: local Supabase derives its name from the
 * request host, and the upstream still sees its own Host header.
 */
export function rewriteSetCookie(value, { secure }) {
  if (typeof value !== 'string') return value
  const parts = value.split(';').map((part) => part.trim()).filter(Boolean)
  const kept = []
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower.startsWith('domain=')) continue
    if (lower === 'secure') {
      if (secure) kept.push(part)
      continue
    }
    if (lower === 'samesite=none') {
      kept.push('SameSite=Lax')
      continue
    }
    kept.push(part)
  }
  return kept.join('; ')
}

export function rewriteLocation(value, upstream, gatewayOrigin) {
  if (typeof value !== 'string') return value
  try {
    const target = new URL(value, upstream)
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')
    const upstreamPort = upstream.port || (upstream.protocol === 'https:' ? '443' : '80')
    const sameOrigin = target.origin === upstream.origin
    // Next dev canonicalizes loopback origins as `localhost` even when the
    // reverse proxy forwards `127.0.0.1` (or vice versa). Treat them as the
    // same app only when the port also matches, so an unrelated loopback
    // service is never pulled into the gateway origin.
    const loopbackAlias =
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname.toLowerCase()) &&
      targetPort === upstreamPort
    if (!sameOrigin && !loopbackAlias) return value
    return `${gatewayOrigin}${target.pathname}${target.search}${target.hash}`
  } catch {
    return value
  }
}

function proxyHeaders(request, upstream, gatewayOrigin) {
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  // Preserve the upstream Host so virtual hosting and server-derived cookie
  // names keep working. The gateway origin is conveyed separately.
  headers.host = upstream.host
  headers['x-forwarded-host'] = request.headers.host || gatewayOrigin.replace(/^https?:\/\//, '')
  headers['x-forwarded-proto'] = new URL(gatewayOrigin).protocol.replace(':', '')
  if (request.socket.remoteAddress) {
    const existing = request.headers['x-forwarded-for']
    headers['x-forwarded-for'] = existing
      ? `${existing}, ${request.socket.remoteAddress}`
      : request.socket.remoteAddress
  }
  return headers
}

function responseHeaders(upstreamResponse, upstream, gatewayOrigin) {
  const headers = {}
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  const secureGateway = gatewayOrigin.startsWith('https:')
  if (headers['set-cookie']) {
    const cookies = Array.isArray(headers['set-cookie'])
      ? headers['set-cookie']
      : [headers['set-cookie']]
    headers['set-cookie'] = cookies.map((header) =>
      rewriteSetCookie(header, { secure: secureGateway }),
    )
  }
  if (headers.location) {
    headers.location = rewriteLocation(headers.location, upstream, gatewayOrigin)
  }
  return headers
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function sendText(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  response.end(body)
}

export async function startGateway({
  upstreamUrl,
  rendererDir,
  host = '127.0.0.1',
  port = 43126,
  profile = { id: 'default', kind: 'remote' },
  logger = console,
}) {
  let upstream
  try {
    upstream = new URL(upstreamUrl)
  } catch {
    throw new Error('Desktop gateway upstream URL is invalid')
  }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new Error('Desktop gateway upstream must be a credential-free HTTP(S) URL')
  }
  if (!existsSync(join(rendererDir, 'index.html'))) {
    throw new Error(`Desktop renderer build was not found at ${rendererDir}`)
  }

  // The profile kind is a client-side routing hint, not a secret. Shared
  // browser-preview code reads it to decide whether a gateway URL belongs to
  // this machine (local profile) or must remain on the remote origin.
  const profileMeta = `  <meta name="openlink-desktop-profile-kind" content="${profile.kind}">\n`
  const rawIndex = await readFile(join(rendererDir, 'index.html'), 'utf8')
  const indexHtml = rawIndex.includes('</head>')
    ? rawIndex.replace('</head>', `${profileMeta}  </head>`)
    : rawIndex.includes('<body')
      ? rawIndex.replace('<body', `${profileMeta}<body`)
      : `${profileMeta}${rawIndex}`

  const requestFn = upstream.protocol === 'https:' ? httpsRequest : httpRequest
  let gatewayOrigin = `http://${host}:${port}`
  const sockets = new Set()
  const upstreamSockets = new Set()

  const server = createServer((request, response) => {
    const incomingHost = request.headers.host || ''
    const allowedHosts = new Set([
      `${host}:${server.address()?.port ?? port}`,
      `localhost:${server.address()?.port ?? port}`,
    ])
    if (!allowedHosts.has(incomingHost)) {
      sendText(response, 421, 'Misdirected Request')
      return
    }

    const origin = request.headers.origin
    if (
      origin &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      origin !== gatewayOrigin
    ) {
      sendText(response, 403, 'Cross-origin request rejected')
      return
    }

    let pathname = '/'
    try {
      // URL parsing normalizes dot segments, which is useful for SPA routes
      // but would erase an attempted traversal before the containment check.
      // Reject encoded/raw traversal segments on the original request target.
      const rawPath = (request.url || '/').split('?')[0]
      if (
        rawPath.includes('\0') ||
        /%2e%2e|%2e%2f/i.test(rawPath) ||
        /(?:^|\/)\.\.(?:\/|$)/.test(rawPath)
      ) {
        sendText(response, 403, 'Forbidden')
        return
      }
      pathname = new URL(request.url || '/', gatewayOrigin).pathname
    } catch {
      sendText(response, 400, 'Bad Request')
      return
    }

    if (pathname === '/__openlink/health') {
      sendJson(response, 200, {
        ok: true,
        profile: profile.id,
        kind: profile.kind,
        upstream: upstream.origin,
      })
      return
    }

    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      const headers = proxyHeaders(request, upstream, gatewayOrigin)
      const proxyRequest = requestFn({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        method: request.method,
        path: `${pathname}${new URL(request.url || '/', gatewayOrigin).search}`,
        headers,
      }, (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          responseHeaders(upstreamResponse, upstream, gatewayOrigin),
        )
        upstreamResponse.pipe(response)
      })
      proxyRequest.setTimeout(0)
      proxyRequest.once('error', (error) => {
        logger.error?.('[desktop-gateway] upstream request failed', error)
        if (!response.headersSent) sendText(response, 502, 'OpenLink upstream is unavailable')
        else response.destroy()
      })
      response.once('close', () => proxyRequest.destroy())
      request.pipe(proxyRequest)
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed')
      return
    }

    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      sendText(response, 400, 'Bad Request')
      return
    }
    const candidate = normalize(join(rendererDir, decoded))
    if (!isPathInside(rendererDir, candidate)) {
      sendText(response, 403, 'Forbidden')
      return
    }

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const immutable = pathname.startsWith('/assets/')
      response.writeHead(200, {
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        'content-type': contentType(candidate),
      })
      if (request.method === 'HEAD') response.end()
      else createReadStream(candidate).pipe(response)
      return
    }

    // SPA fallback. A request for a concrete file that does not exist must not
    // receive index.html (it would hide a broken asset behind a 200 HTML page).
    if (extname(pathname)) {
      sendText(response, 404, 'Not Found')
      return
    }
    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(indexHtml),
    })
    if (request.method === 'HEAD') response.end()
    else response.end(indexHtml)
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (request, clientSocket, clientHead) => {
    let pathname = '/'
    try {
      pathname = new URL(request.url || '/', gatewayOrigin).pathname
    } catch {
      clientSocket.destroy()
      return
    }
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/auth/')) {
      clientSocket.destroy()
      return
    }
    const headers = proxyHeaders(request, upstream, gatewayOrigin)
    headers.connection = 'Upgrade'
    headers.upgrade = request.headers.upgrade || 'websocket'
    const proxyRequest = requestFn({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: `${pathname}${new URL(request.url || '/', gatewayOrigin).search}`,
      headers,
    })
    proxyRequest.once('upgrade', (proxyResponse, upstreamSocket, upstreamHead) => {
      upstreamSockets.add(upstreamSocket)
      upstreamSocket.once('close', () => upstreamSockets.delete(upstreamSocket))
      const lines = [`HTTP/1.1 ${proxyResponse.statusCode ?? 101} ${proxyResponse.statusMessage ?? 'Switching Protocols'}`]
      const raw = proxyResponse.rawHeaders || []
      for (let index = 0; index < raw.length; index += 2) lines.push(`${raw[index]}: ${raw[index + 1]}`)
      clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead?.length) clientSocket.write(upstreamHead)
      if (clientHead?.length) upstreamSocket.write(clientHead)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
      clientSocket.once('close', () => upstreamSocket.destroy())
      upstreamSocket.once('close', () => clientSocket.destroy())
    })
    proxyRequest.once('response', (proxyResponse) => {
      const lines = [`HTTP/1.1 ${proxyResponse.statusCode ?? 502} ${proxyResponse.statusMessage ?? 'Bad Gateway'}`]
      const raw = proxyResponse.rawHeaders || []
      for (let index = 0; index < raw.length; index += 2) lines.push(`${raw[index]}: ${raw[index + 1]}`)
      clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      proxyResponse.pipe(clientSocket)
    })
    proxyRequest.once('error', () => {
      if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
    proxyRequest.end()
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  const actualPort = server.address()?.port ?? port
  gatewayOrigin = `http://${host}:${actualPort}`
  logger.info?.(`[desktop-gateway] ${profile.kind} profile ${profile.id} -> ${upstream.origin} on ${gatewayOrigin}`)

  return {
    origin: gatewayOrigin,
    port: actualPort,
    upstream: upstream.origin,
    async close() {
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      for (const socket of upstreamSockets) socket.destroy()
      upstreamSockets.clear()
      await new Promise((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

/**
 * Try the preferred port first, then a small bounded range. A stable port is
 * preferable because browser cookies are host-scoped but the Supabase cookie
 * name embeds the host header; a changing port would silently orphan them.
 */
export async function startGatewayWithFallback(options) {
  const preferred = Number(options.port ?? 43126)
  let lastError
  for (let offset = 0; offset < 20; offset += 1) {
    try {
      return await startGateway({ ...options, port: preferred + offset })
    } catch (error) {
      lastError = error
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  throw lastError ?? new Error('Unable to bind the desktop gateway port')
}
