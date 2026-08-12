import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { BROWSER_PROTOCOL_VERSION, type BrowserSocketServerMessage } from '@openlink/browser-protocol'
import { BrowserHostServer } from '../src/browser-server.js'
import type { BrowserHostConfig } from '../src/config.js'

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test('native preview is authenticated, proxied, bridge-injected, and action-relayed', async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'" })
    response.end('<!doctype html><html><head><title>Preview</title></head><body><button>Run</button></body></html>')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('No upstream address')

  const port = await availablePort()
  const config: BrowserHostConfig = {
    host: '127.0.0.1', port, publicBaseUrl: `http://127.0.0.1:${port}`,
    apiToken: 'a'.repeat(32), tokenSecret: 's'.repeat(32), allowedParentOrigins: ['http://localhost:3000'],
    storageRoot: '/tmp/openlink-browser-host-test', maxSessions: 4, sessionTtlMs: 60_000,
    controlLeaseTtlMs: 5_000, shutdownTimeoutMs: 5_000,
  }
  const host = new BrowserHostServer(config)
  await host.listen()
  t.after(() => host.close())

  const createResponse = await fetch(`${config.publicBaseUrl}/v1/browser/sessions`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId: 'user-1', workspaceId: 'workspace-1', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'native-preview', preview: { targetUrl: `http://127.0.0.1:${upstreamAddress.port}` } }),
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json() as { session: { id: string }; connection: { previewUrl: string; eventsUrl: string; controlToken: string } }

  const refreshed = await fetch(`${config.publicBaseUrl}/v1/browser/sessions/${encodeURIComponent(created.session.id)}/capability`, {
    method: 'POST', headers: { Authorization: `Bearer ${created.connection.controlToken}` },
  })
  assert.equal(refreshed.status, 200)
  const refreshedPayload = await refreshed.json() as { controlToken?: string; expiresAt?: string }
  assert.ok(refreshedPayload.controlToken)
  assert.ok(refreshedPayload.expiresAt)

  const bootstrap = await fetch(created.connection.previewUrl, { redirect: 'manual' })
  assert.equal(bootstrap.status, 302)
  const cookie = bootstrap.headers.get('set-cookie')
  assert.ok(cookie)
  const page = await fetch(new URL(bootstrap.headers.get('location')!, config.publicBaseUrl), { headers: { Cookie: cookie!.split(';')[0] } })
  const html = await page.text()
  assert.match(html, /openlink-session/)
  assert.match(html, /inspector-bridge\.js/)

  const socket = new WebSocket(created.connection.eventsUrl, { headers: { Origin: 'http://localhost:3000' } })
  await once(socket, 'open')
  t.after(() => socket.close())
  const messages: BrowserSocketServerMessage[] = []
  socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as BrowserSocketServerMessage))
  socket.send(JSON.stringify({
    type: 'action', payload: {
      version: BROWSER_PROTOCOL_VERSION, actionId: 'read-1', sessionId: created.session.id, actor: 'human', action: { type: 'page.read', pageId: 'preview' },
    },
  }))

  const deadline = Date.now() + 2_000
  let command: Extract<BrowserSocketServerMessage, { type: 'event' }> | undefined
  while (Date.now() < deadline) {
    command = messages.find((message): message is Extract<BrowserSocketServerMessage, { type: 'event' }> => message.type === 'event' && message.payload.event.type === 'bridge.command')
    if (command) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(command && command.payload.event.type === 'bridge.command')
  if (command.payload.event.type !== 'bridge.command') throw new Error('No bridge command')
  socket.send(JSON.stringify({
    type: 'bridge.result', commandId: command.payload.event.commandId,
    result: { version: BROWSER_PROTOCOL_VERSION, actionId: 'read-1', sessionId: created.session.id, ok: true, snapshot: '{"nodes":[]}' },
  }))

  const resultDeadline = Date.now() + 2_000
  while (Date.now() < resultDeadline && !messages.some((message) => message.type === 'event' && message.payload.event.type === 'action.result')) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(messages.some((message) => message.type === 'event' && message.payload.event.type === 'action.result'))
})
