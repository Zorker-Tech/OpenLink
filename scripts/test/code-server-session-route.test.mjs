import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { CodeServerGateway } from '../../services/agent-host/dist/src/code-server-gateway.js'

const source = readFileSync(new URL('../../app/api/code-server/sessions/route.ts', import.meta.url), 'utf8')
const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code

function fixture({ user = 'user', chat = true, hostRequest } = {}) {
  const calls = []
  const commonjsModule = { exports: {} }
  const token = 'A'.repeat(43)
  const modules = {
    '@/lib/chat-sessions': {
      isChatSessionId: () => true,
      getChatSession: async () => chat ? { id: 'chat-id', project_id: 'project', workspace_id: 'workspace' } : null,
    },
    '@/lib/platform-cloud-host.server': { cloudComputerSdkRequest: async () => { throw new Error('unexpected cloud call') } },
    '@/lib/runtime-mode.server': { getRuntimeMode: () => 'local' },
    '@/utils/supabase/server': {
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user ? { id: user } : null } }) } }),
    },
  }
  const defaultHostFetch = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) })
    return Response.json({
      version: 1,
      session: {
        sessionId: 'session-id_1',
        url: `http://127.0.0.1:43121/v1/code-server/gateway/sessions/session-id_1/__openlink_bootstrap?token=${token}`,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      },
    }, { status: 201 })
  }
  new Function('require', 'module', 'exports', 'process', 'fetch', code)(name => modules[name], commonjsModule, commonjsModule.exports, {
    env: { OPENLINK_AGENT_HOST_URL: 'http://127.0.0.1:43121', OPENLINK_AGENT_API_TOKEN: 'private' },
  }, hostRequest || defaultHostFetch)
  return {
    calls,
    token,
    post: (origin, extraHeaders = {}) => commonjsModule.exports.POST(new Request(`${origin}/api/code-server/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin', ...extraHeaders },
      body: JSON.stringify({ chatSessionId: 'chat-id' }),
    })),
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

function close(server) {
  return new Promise(resolve => server.close(resolve))
}

test('local session BFF returns a clean same-origin path and one-time bootstrap token for LAN and loopback origins', async () => {
  for (const origin of ['http://192.168.3.2:3000', 'http://localhost:57714', 'http://127.0.0.1:3000']) {
    const f = fixture()
    const response = await f.post(origin)
    assert.equal(response.status, 201)
    assert.equal(f.calls[0].body.frameAncestorOrigin, origin)
    assert.equal(f.calls[0].body.sessionId, 'chat-id')
    assert.equal(response.headers.get('set-cookie'), null)
    const payload = await response.json()
    assert.equal(payload.session.url, '/v1/code-server/gateway/sessions/session-id_1/')
    assert.equal(payload.session.bootstrapToken, f.token)
    assert.equal(payload.session.url.includes(f.token), false)
  }
})

test('cross-site session creation is rejected', async () => {
  const crossSite = fixture()
  const response = await crossSite.post('http://localhost:3000', { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' })
  assert.equal(response.status, 403)
  assert.equal(crossSite.calls.length, 0)
})

test('same-origin bootstrap exchange authorizes a clean iframe URL and rejects replay', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
    })
    response.end('<!doctype html><title>Code Server</title>')
  })
  const upstreamUrl = await listen(upstream)
  const edge = createServer()
  const edgeUrl = await listen(edge)
  const gateway = new CodeServerGateway({ publicBaseUrl: edgeUrl, allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'] })
  edge.on('request', (request, response) => {
    const match = /^\/v1\/code-server\/gateway\/sessions\/([^/]+)(?:\/|$)/.exec(new URL(request.url || '/', edgeUrl).pathname)
    if (!match) { response.writeHead(404).end(); return }
    void gateway.handleHttp(request, response, decodeURIComponent(match[1])).catch(() => {
      response.writeHead(500).end()
    })
  })

  const frameOrigin = 'http://192.168.3.2:3000'
  let issuedSession
  const f = fixture({
    hostRequest: async (_url, options) => {
      const body = JSON.parse(options.body)
      const session = gateway.create({
        ownerId: body.ownerId,
        workspaceId: body.workspaceId,
        projectId: 'project',
        upstream: upstreamUrl,
        frameAncestorOrigin: body.frameAncestorOrigin,
      })
      issuedSession = session
      return Response.json({ version: 1, session }, { status: 201 })
    },
  })

  try {
    const createResponse = await f.post(frameOrigin)
    assert.equal(createResponse.status, 201)
    const payload = await createResponse.json()
    assert.equal(payload.session.url, `/v1/code-server/gateway/sessions/${payload.session.sessionId}/`)
    assert.equal(payload.session.bootstrapToken, new URL(issuedSession.url).searchParams.get('token'))
    const bootstrapUrl = `${edgeUrl}${payload.session.url.replace(/\/$/, '')}/__openlink_bootstrap`
    const bootstrapHeaders = {
      Origin: frameOrigin,
      'X-OpenLink-Code-Server-Bootstrap': payload.session.bootstrapToken,
    }
    const bootstrap = await fetch(bootstrapUrl, { method: 'POST', headers: bootstrapHeaders })
    assert.equal(bootstrap.status, 204)
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    assert.match(bootstrap.headers.get('set-cookie') || '', /HttpOnly/)
    assert.match(bootstrap.headers.get('set-cookie') || '', /SameSite=Strict/)

    const replay = await fetch(bootstrapUrl, { method: 'POST', headers: bootstrapHeaders })
    assert.equal(replay.status, 500)

    const page = await fetch(`${edgeUrl}${payload.session.url}`, { headers: { Cookie: cookie, Origin: frameOrigin } })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') || '', /http:\/\/192\.168\.3\.2:3000/)
    assert.equal(await page.text(), '<!doctype html><title>Code Server</title>')
  } finally {
    gateway.close()
    await Promise.all([close(edge), close(upstream)])
  }
})
