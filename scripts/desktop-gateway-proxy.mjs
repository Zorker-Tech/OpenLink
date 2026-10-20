import { createServer, request as httpRequest } from 'node:http'

const listenHost = process.env.OPENLINK_DESKTOP_GATEWAY_PROXY_HOST || '0.0.0.0'
const listenPort = Number(process.env.OPENLINK_DESKTOP_GATEWAY_PROXY_PORT || 43125)
const upstream = new URL(process.env.OPENLINK_AGENT_HOST_URL || 'http://127.0.0.1:43121')
const internalOrigin = process.env.OPENLINK_DESKTOP_GATEWAY_INTERNAL_ORIGIN || 'http://localhost:3001'

if (upstream.protocol !== 'http:' || !upstream.hostname || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
  throw new Error('Desktop gateway proxy configuration is invalid')
}

function gatewayKind(pathname) {
  if (/^\/v1\/desktop\/gateway\/sessions\/[^/]{1,256}\/[A-Za-z0-9_-]{32,64}\/desktop(?:\/[^?#]*)?$/.test(pathname)) return 'desktop'
  if (/^\/v1\/browser\/gateway\/sessions\/[A-Za-z0-9_-]{1,256}\/(?:events|preview(?:\/[^?#]*)?)$/.test(pathname)) return 'browser'
  if (/^\/v1\/code-server\/gateway\/sessions\/[A-Za-z0-9_-]{1,256}(?:\/[^?#]*)?$/.test(pathname)) return 'code-server'
  return null
}

function responseHeaders(response) {
  const lines = [`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\n`]
  const headers = response.rawHeaders || []
  for (let index = 0; index < headers.length; index += 2) {
    lines.push(`${headers[index]}: ${headers[index + 1]}\r\n`)
  }
  lines.push('\r\n')
  return lines.join('')
}

function upstreamOptions(request, kind) {
  const headers = { ...request.headers, host: upstream.host }
  // Normalize the app origin when browser traffic reaches this gateway via a
  // LAN host/port. Agent Host still validates the session capability in path.
  if (headers.origin) headers.origin = internalOrigin
  return {
    hostname: upstream.hostname,
    port: Number(upstream.port || 80),
    method: request.method || 'GET',
    path: request.url || '/',
    headers,
  }
}

function sendUnavailable(response) {
  if (!response.headersSent) response.writeHead(502, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Gateway unavailable')
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
    return
  }

  let pathname
  try { pathname = new URL(request.url || '/', 'http://gateway.invalid').pathname } catch {
    response.writeHead(400).end()
    return
  }
  const kind = gatewayKind(pathname)
  const allowedMethods = kind === 'desktop'
    ? new Set(['GET', 'HEAD', 'OPTIONS'])
    : new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
  if (!kind) {
    response.writeHead(404, { 'Cache-Control': 'no-store' }).end()
    return
  }
  if (!allowedMethods.has(request.method || '')) {
    response.writeHead(405, { Allow: [...allowedMethods].join(', '), 'Cache-Control': 'no-store' }).end()
    return
  }

  const proxyRequest = httpRequest(upstreamOptions(request, kind), (proxyResponse) => {
    response.writeHead(proxyResponse.statusCode || 502, proxyResponse.statusMessage, proxyResponse.headers)
    proxyResponse.pipe(response)
  })
  proxyRequest.once('error', () => sendUnavailable(response))
  request.pipe(proxyRequest)
})

server.on('upgrade', (request, clientSocket, clientHead) => {
  let pathname
  try { pathname = new URL(request.url || '/', 'http://gateway.invalid').pathname } catch {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return
  }
  const kind = gatewayKind(pathname)
  if (!kind || (request.headers.upgrade || '').toLowerCase() !== 'websocket') {
    clientSocket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    return
  }

  const proxyRequest = httpRequest(upstreamOptions(request, kind))
  proxyRequest.once('upgrade', (proxyResponse, upstreamSocket, upstreamHead) => {
    clientSocket.write(responseHeaders(proxyResponse))
    if (upstreamHead.length) clientSocket.write(upstreamHead)
    if (clientHead.length) upstreamSocket.write(clientHead)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
    clientSocket.once('close', () => upstreamSocket.destroy())
    upstreamSocket.once('close', () => clientSocket.destroy())
  })
  proxyRequest.once('response', (proxyResponse) => {
    clientSocket.write(responseHeaders(proxyResponse))
    proxyResponse.pipe(clientSocket)
  })
  proxyRequest.once('error', () => {
    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
  proxyRequest.end()
})

server.listen(listenPort, listenHost, () => {
  console.log(`OpenLink capability gateway proxy listening on ${listenHost}:${listenPort}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1_500).unref?.()
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
