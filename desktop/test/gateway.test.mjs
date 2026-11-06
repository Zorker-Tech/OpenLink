import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  rewriteLocation,
  rewriteSetCookie,
  startGateway,
} from '../src/main/gateway.mjs'

let rendererDir
let upstream
let upstreamUrl
let gateway
let gatewayOrigin

async function createRenderer(root) {
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><body><div id="root">desktop</div><script type="module" src="/assets/app.js"></script></body></html>',
  )
  await writeFile(join(root, 'assets/app.js'), 'console.log("desktop")')
  return root
}

before(async () => {
  rendererDir = await createRenderer(await mkdtemp(join(tmpdir(), 'openlink-renderer-')))
  upstream = createServer((request, response) => {
    if (request.url === '/api/json') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': [
          'session=abc; Domain=remote.example; Path=/; Secure; SameSite=None',
          'theme=dark; Path=/',
        ],
      })
      response.end(JSON.stringify({ ok: true, host: request.headers.host, forwarded: request.headers['x-forwarded-host'] }))
      return
    }
    if (request.url === '/api/redirect') {
      response.writeHead(302, { location: `${upstreamUrl}/app/home` })
      response.end()
      return
    }
    if (request.url === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: first\n\n')
      setTimeout(() => {
        response.write('data: second\n\n')
        response.end()
      }, 25)
      return
    }
    if (request.url === '/api/echo') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ method: request.method, body, origin: request.headers.origin }))
      })
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('upstream')
  })
  upstream.on('upgrade', (request, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
    socket.write('upstream-ws')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`

  gateway = await startGateway({
    rendererDir,
    upstreamUrl,
    port: 0,
    profile: { id: 'test', kind: 'remote' },
    logger: { info() {}, error() {} },
  })
  gatewayOrigin = gateway.origin
})

after(async () => {
  await gateway?.close()
  upstream.closeAllConnections?.()
  await new Promise((resolve) => upstream.close(resolve))
  await rm(rendererDir, { recursive: true, force: true })
})

test('serves the renderer entry and hashed assets', async () => {
  const index = await fetch(`${gatewayOrigin}/`)
  assert.equal(index.status, 200)
  assert.match(await index.text(), /id="root"/)

  const asset = await fetch(`${gatewayOrigin}/assets/app.js`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /javascript/)
  assert.equal(await asset.text(), 'console.log("desktop")')
})

test('falls back to the SPA entry but not for missing files', async () => {
  const spa = await fetch(`${gatewayOrigin}/app/workspace/chat`)
  assert.equal(spa.status, 200)
  const html = await spa.text()
  assert.match(html, /id="root"/)
  assert.match(html, /name="openlink-desktop-profile-kind" content="remote"/)

  const missing = await fetch(`${gatewayOrigin}/missing.js`)
  assert.equal(missing.status, 404)
})

test('proxies JSON, preserves the upstream Host, and rewrites cookies', async () => {
  const response = await fetch(`${gatewayOrigin}/api/json`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.host, new URL(upstreamUrl).host)
  assert.equal(payload.forwarded, new URL(gatewayOrigin).host)

  const cookies = response.headers.getSetCookie()
  assert.equal(cookies.length, 2)
  assert.doesNotMatch(cookies[0], /domain=/i)
  assert.doesNotMatch(cookies[0], /secure/i)
  assert.match(cookies[0], /SameSite=Lax/i)
  assert.match(cookies[1], /theme=dark/)
})

test('rewrites upstream redirects back to the gateway origin', async () => {
  const response = await fetch(`${gatewayOrigin}/api/redirect`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), `${gatewayOrigin}/app/home`)
})

test('streams SSE without buffering the response', async () => {
  const response = await fetch(`${gatewayOrigin}/api/stream`)
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let sawFirstChunk = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    text += chunk
    if (!sawFirstChunk && text.includes('first')) sawFirstChunk = true
  }
  text += decoder.decode()
  assert.equal(sawFirstChunk, true)
  assert.match(text, /data: first/)
  assert.match(text, /data: second/)
})

test('proxies POST bodies and rejects foreign origins', async () => {
  const accepted = await fetch(`${gatewayOrigin}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: gatewayOrigin },
    body: JSON.stringify({ hello: 'world' }),
  })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), {
    method: 'POST',
    body: '{"hello":"world"}',
    origin: gatewayOrigin,
  })

  const rejected = await fetch(`${gatewayOrigin}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{}',
  })
  assert.equal(rejected.status, 403)
})

test('tunnels WebSocket upgrades', async () => {
  const http = await import('node:http')
  const url = new URL(gatewayOrigin)
  const message = await new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: '/api/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        host: url.host,
      },
    })
    const timer = setTimeout(() => reject(new Error('WebSocket tunnel timed out')), 5_000)
    request.on('upgrade', (_response, socket) => {
      socket.setEncoding('utf8')
      socket.once('data', (chunk) => {
        clearTimeout(timer)
        socket.destroy()
        resolve(String(chunk))
      })
    })
    request.on('error', reject)
    request.end()
  })
  assert.match(message, /upstream-ws/)
})

test('rejects requests with a foreign Host header', async () => {
  const http = await import('node:http')
  const url = new URL(gatewayOrigin)
  const status = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: '/',
        headers: { host: 'evil.example' },
      },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      },
    )
    request.on('error', reject)
    request.end()
  })
  assert.equal(status, 421)
})

test('rejects path traversal outside the renderer directory', async () => {
  // Use a raw request: fetch/undici normalizes dot segments before sending,
  // which would hide the gateway's own containment check.
  const http = await import('node:http')
  const url = new URL(gatewayOrigin)
  const { status, body } = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: '/%2e%2e/%2e%2e/etc/passwd',
        headers: { host: url.host },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body: text }))
      },
    )
    request.on('error', reject)
    request.end()
  })
  assert.ok([403, 404].includes(status))
  assert.doesNotMatch(body, /root:/)
})

test('cookie and redirect rewriting are pure and bounded', () => {
  assert.equal(
    rewriteSetCookie('a=1; Domain=x; Secure; SameSite=None', { secure: false }),
    'a=1; SameSite=Lax',
  )
  assert.equal(
    rewriteSetCookie('a=1; Domain=x; Secure; SameSite=None', { secure: true }),
    'a=1; Secure; SameSite=Lax',
  )
  const upstreamUrlObject = new URL('https://remote.example/base')
  assert.equal(
    rewriteLocation('https://remote.example/app?x=1', upstreamUrlObject, 'http://127.0.0.1:43126'),
    'http://127.0.0.1:43126/app?x=1',
  )
  assert.equal(
    rewriteLocation('https://idp.example/login', upstreamUrlObject, 'http://127.0.0.1:43126'),
    'https://idp.example/login',
  )
  const localhostUpstream = new URL('http://127.0.0.1:3000')
  assert.equal(
    rewriteLocation('http://localhost:3000/app', localhostUpstream, 'http://127.0.0.1:43126'),
    'http://127.0.0.1:43126/app',
  )
  assert.equal(
    rewriteLocation('http://127.0.0.1:9999/app', localhostUpstream, 'http://127.0.0.1:43126'),
    'http://127.0.0.1:9999/app',
  )
})
