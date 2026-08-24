// Local-only origin reverse proxy for upstream Supabase Studio.
//
// Chromium treats `localhost` and `studio.localhost` as different sites, so a
// SameSite cookie set on `localhost` is never sent to an iframe hosted at
// `studio.localhost`. Running Studio on a second port of the SAME `localhost`
// host keeps the request same-site (ports are ignored for site computation),
// which lets the cookie flow while preserving a separate `/` and `/_next`
// namespace (the second port resolves its own root-relative assets).
//
// This process forwards every request to the Next BFF (port 3001) and tags it
// with `x-openlink-internal-studio: 1` so proxy.ts routes it to the internal
// Studio handler instead of the application.

import { createServer, request } from 'node:http'

const upstreamPort = Number(process.env.OPENLINK_WEB_PORT || 3001)
const listenPort = Number(process.env.OPENLINK_STUDIO_PORT || 3002)

const FORWARDED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'if-none-match',
  'if-modified-since',
  'range',
  'user-agent',
  'referer',
  'origin',
  'upgrade-insecure-requests',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'cookie',
])

function proxyRequest(clientRequest, clientResponse) {
  const headers = { 'x-openlink-internal-studio': '1' }
  for (const [name, value] of Object.entries(clientRequest.headers)) {
    if (FORWARDED_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers[name] = value
  }
  const upstream = {
    hostname: '127.0.0.1',
    port: upstreamPort,
    path: clientRequest.url,
    method: clientRequest.method,
    headers,
  }
  const req = request(upstream, (res) => {
    clientResponse.writeHead(res.statusCode, res.statusMessage, res.headers)
    res.pipe(clientResponse)
  })
  req.on('error', () => {
    if (!clientResponse.headersSent) clientResponse.writeHead(502)
    clientResponse.end()
  })
  clientRequest.pipe(req)
}

const server = createServer((req, res) => proxyRequest(req, res))
server.listen(listenPort, '127.0.0.1', () => {
  console.log(`OpenLink Studio origin proxy listening on http://127.0.0.1:${listenPort}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  // Fall back if connections keep the handle open.
  setTimeout(() => process.exit(0), 1_500).unref?.()
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
