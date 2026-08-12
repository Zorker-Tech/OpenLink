import { createServer, type Server } from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import { BrowserGateway } from '../src/browser-gateway.js'
import type { BrowserAgentSession } from '../src/browser-client.js'

function session(eventsUrl: string, previewUrl: string): BrowserAgentSession {
  return {
    state: {
      version: 1,
      id: 'browser-session-1',
      ownerId: 'user-1',
      workspaceId: 'workspace-1',
      projectId: '11111111-1111-4111-8111-111111111111',
      surface: 'native-preview',
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      controlOwner: null,
      activePageId: 'preview',
      pages: [{
        id: 'preview',
        url: `${new URL(previewUrl).origin}/v1/browser/sessions/browser-session-1/preview/`,
        title: 'Preview',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        active: true,
      }],
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      capabilities: {
        nativeDom: true,
        screencast: false,
        componentInspection: true,
        downloads: true,
        uploads: true,
        dialogs: true,
        devtools: false,
      },
    },
    controlToken: 'internal-control-token',
    connection: { eventsUrl, previewUrl, bridgeNonce: 'nonce' },
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
}

test('browser gateway proxies preview without exposing internal capability URLs', async () => {
  const upstream = createServer((request, response) => {
    if (request.url?.startsWith('/v1/browser/sessions/browser-session-1/preview/')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'target=ok; Path=/v1/browser/sessions/browser-session-1/preview/' })
      response.end('<html><head></head><body><script src="/v1/browser/inspector-bridge.js"></script></body></html>')
      return
    }
    if (request.url === '/v1/browser/inspector-bridge.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' })
      response.end('window.__bridge = true')
      return
    }
    response.writeHead(404)
    response.end()
  })
  const upstreamPort = await listen(upstream)
  let publicGateway!: BrowserGateway
  const publicServer = createServer((request, response) => {
    const pathname = new URL(request.url || '/', `http://127.0.0.1:${(publicServer.address() as { port: number }).port}`).pathname
    const match = /^\/v1\/browser\/gateway\/sessions\/([^/]+)\/preview(?:\/|$)/.exec(pathname)
    if (!match) { response.writeHead(404); response.end(); return }
    void publicGateway.handleHttp(request, response, decodeURIComponent(match[1]!)).catch((error) => {
      if (!response.headersSent) { response.writeHead(401); response.end(error instanceof Error ? error.message : String(error)) }
    })
  })
  await listen(publicServer)
  const actualPort = (publicServer.address() as { port: number }).port
  publicGateway = new BrowserGateway({ publicBaseUrl: `http://127.0.0.1:${actualPort}`, allowedOrigins: ['http://localhost:3000'] })
  publicServer.on('upgrade', (request, socket, head) => publicGateway.handleUpgrade(request, socket, head))
  const created = publicGateway.register(session(
    `ws://127.0.0.1:${upstreamPort}/v1/browser/sessions/browser-session-1/events?token=internal-events-token`,
    `http://127.0.0.1:${upstreamPort}/v1/browser/sessions/browser-session-1/preview/__openlink_bootstrap?token=internal-preview-token`,
  ))

  assert.match(created.connection.eventsUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${actualPort}/v1/browser/gateway/`))
  assert.ok(!created.connection.eventsUrl.includes('internal-events-token'))
  assert.ok(created.connection.previewUrl)
  assert.ok(!created.connection.previewUrl!.includes('internal-preview-token'))
  const bound = publicGateway.getAgentSession('browser-session-1', {
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    projectId: '11111111-1111-4111-8111-111111111111',
  })
  assert.equal(bound.controlToken, 'internal-control-token')
  assert.throws(() => publicGateway.getAgentSession('browser-session-1', {
    ownerId: 'other-user',
    workspaceId: 'workspace-1',
    projectId: '11111111-1111-4111-8111-111111111111',
  }), /does not belong/)
  assert.ok(created.state.pages[0]!.url.includes('/v1/browser/gateway/sessions/browser-session-1/preview/'))

  const bootstrap = await fetch(created.connection.previewUrl!, { redirect: 'manual', headers: { Origin: 'http://localhost:3000' } })
  assert.equal(bootstrap.status, 302)
  assert.equal(bootstrap.headers.get('location'), '/v1/browser/gateway/sessions/browser-session-1/preview/')
  const cookie = bootstrap.headers.get('set-cookie')
  assert.ok(cookie)
  assert.ok(!cookie!.includes('internal-preview-token'))
  const page = await fetch(`http://127.0.0.1:${actualPort}${bootstrap.headers.get('location')!}`, {
    headers: { Origin: 'http://localhost:3000', Cookie: cookie!.split(';')[0]! },
  })
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.ok(html.includes('/v1/browser/gateway/sessions/browser-session-1/preview/inspector-bridge.js'))
  assert.ok(!html.includes('/v1/browser/inspector-bridge.js'))

  publicGateway.close()
  await new Promise<void>((resolve) => publicServer.close(() => resolve()))
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

test('browser gateway queues the first websocket message until Browser Host connects', async () => {
  const upstream = createServer()
  const upstreamSockets = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.origin, 'http://localhost:3000')
    upstreamSockets.handleUpgrade(request, socket, head, (client) => {
      client.on('message', () => client.send(JSON.stringify({
        type: 'snapshot',
        payload: {
          previewUrl: `http://127.0.0.1:${upstreamPort}/v1/browser/sessions/browser-session-1/preview/__openlink_bootstrap`,
        },
      })))
    })
  })
  const upstreamPort = await listen(upstream)
  const gatewayServer = createServer()
  const gatewayPort = await listen(gatewayServer)
  const gateway = new BrowserGateway({ publicBaseUrl: `http://127.0.0.1:${gatewayPort}`, allowedOrigins: ['http://localhost:3000'] })
  gatewayServer.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head))
  const created = gateway.register(session(
    `ws://127.0.0.1:${upstreamPort}/v1/browser/sessions/browser-session-1/events?token=internal-events-token`,
    `http://127.0.0.1:${upstreamPort}/v1/browser/sessions/browser-session-1/preview/__openlink_bootstrap?token=internal-preview-token`,
  ))

  const snapshot = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(created.connection.eventsUrl, { origin: 'http://localhost:3000' })
    socket.once('error', reject)
    socket.once('open', () => socket.send('{"type":"subscribe","afterSequence":0}'))
    socket.once('message', (data) => { resolve(data.toString()); socket.close() })
  })
  assert.ok(snapshot.includes('/v1/browser/gateway/sessions/browser-session-1/preview/__openlink_bootstrap'))
  assert.ok(!snapshot.includes('127.0.0.1'))

  gateway.close()
  await new Promise<void>((resolve) => gatewayServer.close(() => resolve()))
  upstreamSockets.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})
