import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { CodeServerGateway } from '../src/code-server-gateway.js'

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('code-server gateway exchanges the one-time bootstrap token and rewrites CSP before proxying the workbench', async () => {
  let upstreamAuthorization: string | undefined
  const upstream = createServer((request, response) => {
    upstreamAuthorization = request.headers.authorization
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
    })
    response.end('<!doctype html><title>VS Code</title>')
  })
  const upstreamUrl = await listen(upstream)

  const gateway = new CodeServerGateway({
    publicBaseUrl: 'http://127.0.0.1:0',
    allowedOrigins: ['http://localhost:3002'],
  })
  const edge = createServer((request, response) => {
    const match = /^\/v1\/code-server\/gateway\/sessions\/([^/]+)(?:\/|$)/.exec(new URL(request.url || '/', 'http://localhost').pathname)
    if (!match) { response.writeHead(404); response.end(); return }
    void gateway.handleHttp(request, response, decodeURIComponent(match[1]!)).catch((error) => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  edge.on('upgrade', (request, socket, head) => {
    if (!gateway.handleUpgrade(request, socket, head)) socket.destroy()
  })
  const edgeUrl = await listen(edge)
  // The public URL is allocated after the edge port is known; recreate the
  // tiny gateway binding with the final reachable public origin.
  gateway.close()
  const reachableGateway = new CodeServerGateway({ publicBaseUrl: edgeUrl, allowedOrigins: ['http://localhost:3002'] })
  edge.removeAllListeners('request')
  edge.on('request', (request, response) => {
    const match = /^\/v1\/code-server\/gateway\/sessions\/([^/]+)(?:\/|$)/.exec(new URL(request.url || '/', edgeUrl).pathname)
    if (!match) { response.writeHead(404); response.end(); return }
    void reachableGateway.handleHttp(request, response, decodeURIComponent(match[1]!)).catch((error) => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  edge.removeAllListeners('upgrade')
  edge.on('upgrade', (request, socket, head) => {
    if (!reachableGateway.handleUpgrade(request, socket, head)) socket.destroy()
  })

  const session = reachableGateway.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', upstream: upstreamUrl,
  })
  try {
    const bootstrap = await fetch(session.url, { redirect: 'manual' })
    assert.equal(bootstrap.status, 302)
    const cookie = bootstrap.headers.get('set-cookie')
    assert.ok(cookie?.includes('HttpOnly'))
    const location = bootstrap.headers.get('location')
    assert.ok(location)

    const page = await fetch(`${edgeUrl}${location}`, {
      headers: { Cookie: cookie!.split(';')[0]!, Authorization: 'Bearer must-not-reach-code-server' },
    })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors http:\/\/localhost:3002/)
    assert.doesNotMatch(page.headers.get('content-security-policy') || '', /frame-ancestors 'self'/)
    assert.equal(page.headers.get('x-frame-options'), null)
    assert.equal(upstreamAuthorization, undefined)
    assert.equal(await page.text(), '<!doctype html><title>VS Code</title>')
  } finally {
    reachableGateway.close()
    await Promise.all([close(edge), close(upstream)])
  }
})

test('code-server gateway preserves VS Code initial WebSocket frames and uses the VM-local origin', async () => {
  const upstream = createServer()
  const upstreamSockets = new WebSocketServer({ noServer: true })
  let upstreamOrigin: string | undefined
  upstream.on('upgrade', (request, socket, head) => {
    upstreamOrigin = request.headers.origin
    upstreamSockets.handleUpgrade(request, socket, head, (client) => {
      client.once('message', (data) => client.send(data))
    })
  })
  const upstreamUrl = await listen(upstream)

  const edge = createServer()
  const edgeUrl = await listen(edge)
  const gateway = new CodeServerGateway({ publicBaseUrl: edgeUrl, allowedOrigins: ['http://localhost:3002'] })
  edge.on('upgrade', (request, socket, head) => {
    if (!gateway.handleUpgrade(request, socket, head)) socket.destroy()
  })
  const session = gateway.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', upstream: upstreamUrl,
  })

  try {
    const socketUrl = session.url.replace('/__openlink_bootstrap', '')
    const response = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(socketUrl, { origin: 'http://localhost:3002' })
      socket.once('error', reject)
      socket.once('open', () => socket.send('vscode-initial-greeting'))
      socket.once('message', (data) => {
        socket.close()
        resolve(data.toString())
      })
    })
    assert.equal(response, 'vscode-initial-greeting')
    assert.equal(upstreamOrigin, upstreamUrl)
  } finally {
    gateway.close()
    upstreamSockets.close()
    await Promise.all([close(edge), close(upstream)])
  }
})
