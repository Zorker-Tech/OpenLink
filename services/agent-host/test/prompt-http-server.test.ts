import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startPromptHttpServer, type PromptRuntimeBackend } from '../src/prompt-http-server.js'
import type { ProjectRuntimeManager } from '../src/project-runtime.js'

test('Codex plugin snapshot invalidation is authenticated and explicit', async (context) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-plugin-invalidate-route-'))
  context.after(async () => { await rm(storageRoot, { recursive: true, force: true }) })
  let invalidations = 0
  let creations = 0
  let cleanups = 0
  const backend: PromptRuntimeBackend = {
    createSession: async () => {
      creations += 1
      return { prompt: async () => new Response(), cleanup: async () => { cleanups += 1 } }
    },
    close: async () => {},
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test', sessionIdleTtlMs: 60_000,
    invalidateCodexPluginSnapshot: () => { invalidations += 1 },
  }, backend)
  context.after(async () => { runtime.server.close(); await runtime.shutdown() })
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}/v1/agent/plugins/invalidate`
  const leaseUrl = `http://127.0.0.1:${address.port}/v1/agent/sessions/plugin-session/lease`
  const headers = { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }
  const leaseBody = JSON.stringify({
    userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'plugin-session',
    runtimeConfiguration: { providerId: 'openai', modelId: 'gpt-test', apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', revision: 'revision' },
    agent: 'codex', accessMode: 'restricted',
  })
  assert.equal((await fetch(leaseUrl, { method: 'POST', headers, body: leaseBody })).status, 200)
  const denied = await fetch(endpoint, { method: 'POST' })
  assert.equal(denied.status, 403)
  const accepted = await fetch(endpoint, { method: 'POST', headers })
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { ok: true })
  assert.equal((await fetch(leaseUrl, { method: 'POST', headers, body: leaseBody })).status, 200)
  assert.equal(invalidations, 1)
  assert.equal(creations, 2)
  assert.equal(cleanups, 1)
})

test('prompt server authenticates, streams NDJSON, and enforces runtime capacity', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-server-test-'))
  let closes = 0
  let receivedAttachments: unknown
  const imageAttachment = { type: 'image' as const, mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=', filename: 'sample.png' }
  const textAttachment = { type: 'text' as const, mediaType: 'text/plain' as const, text: 'pasted context', filename: '已粘贴的文本.txt' }
  const referenceAttachment = { type: 'reference' as const, referenceType: 'thread' as const, name: 'Previous task', path: 'thread://task-123' }
  const fileContent = Buffer.from('hello')
  const fileAttachment = {
    type: 'file' as const,
    uploadId: '11111111-1111-4111-8111-111111111111',
    batchId: '22222222-2222-4222-8222-222222222222',
    mediaType: 'text/plain',
    filename: 'notes.txt',
    relativePath: 'sample/docs/notes.txt',
    sizeBytes: fileContent.length,
    sha256: createHash('sha256').update(fileContent).digest('hex'),
    contentBase64: fileContent.toString('base64'),
  }
  const backend: PromptRuntimeBackend = {
    createSession: async (_userId, _workspaceId, sessionId) => ({
      prompt: async (message, _signal, attachments) => {
        receivedAttachments = attachments
        return new Response(`${JSON.stringify({ type: 'echo', sessionId, message })}\n`, {
        headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
      cleanup: async () => { closes += 1 },
    }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: 'test-token-which-is-long-enough',
    storageRoot,
    transport: 'test-runtime',
    sessionIdleTtlMs: 60_000,
    maxSessions: 1,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    const denied = await fetch(`${endpoint}/v1/agent/sessions/one/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello', attachments: [imageAttachment], runtimeConfiguration: {
          providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision',
        }
      }),
    })
    assert.equal(denied.status, 403)

    const accepted = await fetch(`${endpoint}/v1/agent/sessions/one/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello', attachments: [imageAttachment, textAttachment, referenceAttachment, fileAttachment], runtimeConfiguration: {
          providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision',
        }
      }),
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.headers.get('x-openlink-agent-transport'), 'test-runtime')
    assert.deepEqual(JSON.parse((await accepted.text()).trim()), { type: 'echo', sessionId: 'one', message: 'hello' })
    assert.deepEqual(receivedAttachments, [imageAttachment, textAttachment, referenceAttachment, fileAttachment])

    const tampered = await fetch(`${endpoint}/v1/agent/sessions/one/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello', attachments: [{ ...fileAttachment, sha256: '0'.repeat(64) }], runtimeConfiguration: {
          providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision',
        }
      }),
    })
    assert.equal(tampered.status, 400)

    const capacity = await fetch(`${endpoint}/v1/agent/sessions/two/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello', runtimeConfiguration: {
          providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision',
        }
      }),
    })
    assert.equal(capacity.status, 409)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
  assert.equal(closes, 1)
})

test('code-server session creation is authenticated and bound to the requested Project runtime', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-code-server-route-test-'))
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<title>VS Code</title>')
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    upstream.once('error', rejectListen)
    upstream.listen(0, '127.0.0.1', () => {
      upstream.removeListener('error', rejectListen)
      resolveListen()
    })
  })
  const upstreamAddress = upstream.address() as AddressInfo
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  let ensuredProject: string | undefined
  const projectRuntimeManager = {
    ensure: async (id: string) => {
      ensuredProject = id
      return { codeServerEndpoint: `http://127.0.0.1:${upstreamAddress.port}` }
    },
  } as unknown as ProjectRuntimeManager
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({ prompt: async () => new Response(''), cleanup: async () => { } }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000,
    projectRuntimeManager,
    browserGatewayPublicUrl: 'http://127.0.0.1:0',
    browserGatewayAllowedOrigins: ['http://localhost:3002'],
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    const denied = await fetch(`${endpoint}/v1/projects/${projectId}/code-server/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerId: 'user', workspaceId: 'workspace' }),
    })
    assert.equal(denied.status, 403)

    const created = await fetch(`${endpoint}/v1/projects/${projectId}/code-server/sessions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId: 'user', workspaceId: 'workspace' }),
    })
    assert.equal(created.status, 201)
    assert.equal(ensuredProject, projectId)
    const payload = await created.json() as { session?: { url?: string } }
    assert.match(payload.session?.url || '', /^http:\/\/127\.0\.0\.1:0\/v1\/code-server\/gateway/)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()))
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('rejects private IPv4 and IPv4-mapped IPv6 provider endpoints', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-provider-endpoint-test-'))
  let creations = 0
  const backend: PromptRuntimeBackend = {
    createSession: async () => {
      creations += 1
      return { prompt: async () => new Response(''), cleanup: async () => { } }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: 'test-token-which-is-long-enough',
    storageRoot,
    transport: 'test-runtime',
    sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const request = (baseUrl: string) => fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/private/events`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'user',
      workspaceId: 'workspace',
      projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
      message: 'hello',
      runtimeConfiguration: {
        providerId: 'deepseek',
        modelId: 'deepseek-v4-flash',
        apiKey: 'test-key',
        baseUrl,
        revision: 'test-revision',
      },
    }),
  })
  try {
    assert.equal((await request('https://127.0.0.1')).status, 400)
    assert.equal((await request('https://[::ffff:127.0.0.1]')).status, 400)
    assert.equal((await request('https://[0:0:0:0:0:ffff:127.0.0.1]')).status, 400)
    assert.equal(creations, 0)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('agent lease refresh touches existing runtimes without provisioning a sandbox', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-lease-test-'))
  let creations = 0
  const backend: PromptRuntimeBackend = {
    createSession: async () => {
      creations += 1
      return {
        prompt: async () => new Response(`${JSON.stringify({ type: 'agent_settled' })}\n`),
        cleanup: async () => { },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  try {
    const lease = await fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/leaseable/lease`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'leaseable' }),
    })
    assert.equal(lease.status, 200)
    assert.deepEqual(await lease.json(), { ok: true, active: 0 })
    assert.equal(creations, 0)
    const resources = await fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/leaseable/resources`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'leaseable' }),
    })
    assert.equal(resources.ok, false)
    await resources.text()
    assert.equal(creations, 0, 'passive resource inspection must not provision a Worker')
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('agent lease warms one Worker before the first prompt and reuses it', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-warmup-test-'))
  let creations = 0
  let resumes = 0
  const backend: PromptRuntimeBackend = {
    createSession: async () => {
      creations += 1
      let paused = false
      return {
        pause: async () => { paused = true },
        resume: async () => { paused = false; resumes += 1 },
        prompt: async () => new Response(`${JSON.stringify({ type: 'agent_settled', paused })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }),
        cleanup: async () => { },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  const warmup = () => fetch(`${endpoint}/v1/agent/sessions/warmable/lease`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'warmable',
      runtimeConfiguration: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision' },
    }),
  })
  try {
    const first = await warmup()
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true, active: 1, ready: true, paused: false })
    const second = await warmup()
    assert.equal(second.status, 200)
    assert.equal(creations, 1)
    const prompt = await fetch(`${endpoint}/v1/agent/sessions/warmable/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello',
        runtimeConfiguration: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision' },
      }),
    })
    assert.equal(prompt.status, 200)
    assert.equal(resumes, 0)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('codex lease warmup preserves agent identity and access mode for the first prompt', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-codex-warmup-test-'))
  const creations: Array<{ agent?: 'pi' | 'codex'; accessMode?: 'restricted' | 'ask' | 'open'; nativeSessionPresent: boolean }> = []
  const backend: PromptRuntimeBackend = {
    createSession: async (_userId, _workspaceId, _sessionId, _runtime, nativeSession, _projectId, _projectRuntime, _browser, options) => {
      creations.push({ agent: options?.agent, accessMode: options?.accessMode, nativeSessionPresent: nativeSession !== undefined })
      return {
        prompt: async () => new Response(`${JSON.stringify({ type: 'turn_completed' })}\n`),
        cleanup: async () => { },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  const runtimeConfiguration = {
    providerId: 'openai', modelId: 'gpt-5.6-terra', apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', revision: 'test-revision',
  }
  try {
    const warmup = await fetch(`${endpoint}/v1/agent/sessions/codex-warmable/lease`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'codex-warmable',
        runtimeConfiguration, agent: 'codex', accessMode: 'restricted',
      }),
    })
    assert.equal(warmup.status, 200)
    const prompt = await fetch(`${endpoint}/v1/agent/sessions/codex-warmable/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello',
        runtimeConfiguration, agent: 'codex', accessMode: 'restricted',
      }),
    })
    assert.equal(prompt.status, 200)
    assert.deepEqual(creations, [{ agent: 'codex', accessMode: 'restricted', nativeSessionPresent: false }])
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('runtime resources materialize a missing worker without a synthetic prompt', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-runtime-resources-test-'))
  let creations = 0
  let resourceRequest: unknown
  const backend: PromptRuntimeBackend = {
    createSession: async () => {
      creations += 1
      return {
        prompt: async () => new Response(''),
        resources: async (request) => {
          resourceRequest = request
          return { agent: 'codex', source: 'Codex App Server', accessMode: 'ask', imageGeneration: false, mcpServers: [{ id: 'openlink_supabase', name: 'OpenLink Supabase' }] }
        },
        cleanup: async () => { },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({ host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot, transport: 'test-runtime', sessionIdleTtlMs: 60_000 }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  const body = { userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'resourceable', runtimeConfiguration: { providerId: 'openai', modelId: 'gpt-5.6-terra', apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1', revision: 'test-revision' }, agent: 'codex', accessMode: 'ask' }
  try {
    const headers = { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }
    const resources = await fetch(`${endpoint}/v1/agent/sessions/resourceable/resources?scope=command&command=plugins&query=fig`, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(resources.status, 200)
    assert.deepEqual(await resources.json(), { agent: 'codex', source: 'Codex App Server', accessMode: 'ask', imageGeneration: false, mcpServers: [{ id: 'openlink_supabase', name: 'OpenLink Supabase' }] })
    assert.deepEqual(resourceRequest, { scope: 'command', command: 'plugins', query: 'fig' })
    assert.equal(creations, 1)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('reattaches a durable worker after Host restart and preserves it during shutdown', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-runtime-reattach-test-'))
  let recoveries = 0
  let creations = 0
  let cleanups = 0
  const backend: PromptRuntimeBackend = {
    recoverSession: async () => {
      recoveries += 1
      return {
        prompt: async () => new Response(''),
        resources: async () => ({ agent: 'pi', source: 'Pi Resource Loader', commands: [] }),
        cleanup: async () => { cleanups += 1 },
      }
    },
    createSession: async () => {
      creations += 1
      return { prompt: async () => new Response(''), cleanup: async () => { cleanups += 1 } }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000, preserveSessionsOnShutdown: true,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const body = {
    userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'reattachable',
    runtimeConfiguration: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'restart-test' },
    agent: 'pi', accessMode: 'restricted',
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/reattachable/resources`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    assert.equal(recoveries, 1)
    assert.equal(creations, 0)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
  assert.equal(cleanups, 0)
})

test('agent cancellation aborts the active worker without deleting the reusable session', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-cancel-test-'))
  let promptAborted = false
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({
      prompt: async (_message, signal) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            promptAborted = true
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'agent_settled' })}\n`))
            controller.close()
          }, { once: true })
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } }),
      cleanup: async () => { },
    }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  const body = {
    userId: 'user',
    workspaceId: 'workspace',
    projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
    sessionId: 'cancelable',
    message: 'hello',
    runtimeConfiguration: {
      providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision',
    },
  }
  const headers = { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }
  try {
    const prompt = await fetch(`${endpoint}/v1/agent/sessions/${body.sessionId}/events`, {
      method: 'POST', headers: { ...headers, 'X-OpenLink-Drain-On-Close': '1' }, body: JSON.stringify(body),
    })
    assert.equal(prompt.status, 200)
    const cancel = await fetch(`${endpoint}/v1/agent/sessions/${body.sessionId}/cancel`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    assert.equal(cancel.status, 202)
    assert.deepEqual(await cancel.json(), { ok: true, active: true })
    assert.match(await prompt.text(), /agent_settled/)
    assert.equal(promptAborted, true)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('extension UI responses are authorized, routed to the active runtime, and streamed back', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-extension-ui-test-'))
  let receivedUiResponse: { id: string; confirmed?: boolean; cancelled?: true; value?: string } | undefined
  let firstFrame!: () => void
  const firstFrameSeen = new Promise<void>((resolveFrame) => { firstFrame = resolveFrame })
  let closeStream!: (response: { id: string; confirmed?: boolean; cancelled?: true; value?: string }) => void
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({
      prompt: async (_message, signal) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Confirm', message: 'Continue?' })}\n`))
          firstFrame()
          closeStream = (response) => {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'openlink_confirmation_resolved', ...response })}\n`))
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'agent_settled' })}\n`))
            controller.close()
          }
          signal?.addEventListener('abort', () => controller.close(), { once: true })
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } }),
      resolveExtensionUi: async (response) => {
        receivedUiResponse = response
        closeStream(response)
      },
      cleanup: async () => { },
    }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  const body = {
    userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
    message: 'hello',
    runtimeConfiguration: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision' },
  }
  const headers = { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }
  try {
    const prompt = await fetch(`${endpoint}/v1/agent/sessions/extension/events`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    assert.equal(prompt.status, 200)
    const reader = prompt.body!.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /extension_ui_request/)
    await firstFrameSeen

    const denied = await fetch(`${endpoint}/v1/agent/sessions/extension/extension-ui-response`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'user', workspaceId: 'workspace', projectId: body.projectId, id: 'confirm-1', confirmed: true }),
    })
    assert.equal(denied.status, 403)
    const resolved = await fetch(`${endpoint}/v1/agent/sessions/extension/extension-ui-response`, {
      method: 'POST', headers, body: JSON.stringify({ userId: 'user', workspaceId: 'workspace', projectId: body.projectId, id: 'confirm-1', confirmed: true }),
    })
    assert.equal(resolved.status, 202)
    assert.deepEqual(await resolved.json(), { ok: true })
    // The two trailing events can arrive in separate chunks under load; drain
    // the stream until both are observed instead of assuming a single read.
    let streamed = ''
    while (!/agent_settled/.test(streamed)) {
      const chunk = await reader.read()
      if (chunk.done) break
      streamed += new TextDecoder().decode(chunk.value)
    }
    assert.match(streamed, /openlink_confirmation_resolved/)
    assert.match(streamed, /agent_settled/)
    assert.deepEqual(receivedUiResponse, { id: 'confirm-1', confirmed: true })
    await reader.cancel()
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('prompt server forwards the selected provider and Pi-native Cloud session snapshot', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-native-session-test-'))
  let captured: Parameters<PromptRuntimeBackend['createSession']> | undefined
  const backend: PromptRuntimeBackend = {
    createSession: async (...parameters) => {
      captured = parameters
      return {
        prompt: async () => new Response(`${JSON.stringify({ type: 'agent_settled' })}\n`),
        cleanup: async () => { },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: 'test-token-which-is-long-enough',
    storageRoot,
    transport: 'test-runtime',
    sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/native/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user',
        workspaceId: 'workspace',
        projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
        message: 'continue',
        runtimeConfiguration: {
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
          apiKey: 'credential-placeholder',
          baseUrl: 'https://api.deepseek.com',
          revision: '2026-08-06T00:00:00.000Z',
        },
        nativeSession: {
          header: { type: 'session', version: 3, id: 'pi-session', timestamp: '2026-08-06T00:00:00.000Z', cwd: '/workspace' },
          entries: [{ type: 'message', id: 'entry-1', parentId: null, timestamp: '2026-08-06T00:00:01.000Z', message: { role: 'user', content: 'hello' } }],
        },
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(captured?.[3]?.providerId, 'deepseek')
    assert.equal(captured?.[3]?.modelId, 'deepseek-v4-flash')
    assert.equal(captured?.[4]?.header.id, 'pi-session')
    assert.equal(captured?.[4]?.entries.length, 1)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('replaces an idle runtime before enforcing global capacity during model switching', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-model-switch-test-'))
  const createdModels: string[] = []
  let cleanups = 0
  const backend: PromptRuntimeBackend = {
    createSession: async (...parameters) => {
      createdModels.push(parameters[3].modelId)
      return {
        prompt: async () => new Response(`${JSON.stringify({ type: 'agent_settled', model: parameters[3].modelId })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }),
        cleanup: async () => { cleanups += 1 },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: 'test-token-which-is-long-enough',
    storageRoot,
    transport: 'test-runtime',
    sessionIdleTtlMs: 60_000,
    maxSessions: 1,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const request = (modelId: string, revision: string) => fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/switchable/events`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'user',
      workspaceId: 'workspace',
      projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
      message: 'continue',
      runtimeConfiguration: { providerId: 'deepseek', modelId, apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision },
    }),
  })
  try {
    assert.equal((await request('deepseek-v3', 'revision-1')).status, 200)
    const switched = await request('deepseek-v4-flash', 'revision-2')
    assert.equal(switched.status, 200)
    assert.deepEqual(createdModels, ['deepseek-v3', 'deepseek-v4-flash'])
    assert.equal(cleanups, 1)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
  assert.equal(cleanups, 2)
})

test('recreates an expired OpenSandbox workload from the Cloud session snapshot', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-sandbox-recovery-test-'))
  let creations = 0
  let cleanups = 0
  const backend: PromptRuntimeBackend = {
    createSession: async () => {
      creations += 1
      const attempt = creations
      return {
        prompt: async () => attempt === 1
          ? new Response(JSON.stringify({ code: 'DOCKER::SANDBOX_NOT_FOUND', message: 'expired sandbox' }), { status: 404 })
          : new Response(`${JSON.stringify({ type: 'agent_settled', attempt })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }),
        cleanup: async () => { cleanups += 1 },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: 'test-token-which-is-long-enough',
    storageRoot,
    transport: 'test-runtime',
    sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/recoverable/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user',
        workspaceId: 'workspace',
        projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
        message: 'continue',
        runtimeConfiguration: {
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com',
          revision: 'test-revision',
        },
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse((await response.text()).trim()), { type: 'agent_settled', attempt: 2 })
    assert.equal(creations, 2)
    assert.equal(cleanups, 1)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
  assert.equal(cleanups, 2)
})

test('fails closed when an expired workload cannot be cleaned up', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-sandbox-cleanup-failure-test-'))
  let creations = 0
  let cleanups = 0
  const backend: PromptRuntimeBackend = {
    createSession: async () => {
      creations += 1
      return {
        prompt: async () => new Response(JSON.stringify({ code: 'DOCKER::SANDBOX_NOT_FOUND', message: 'expired sandbox' }), { status: 404 }),
        cleanup: async () => {
          cleanups += 1
          throw new Error('sandbox delete failed')
        },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: 'test-token-which-is-long-enough',
    storageRoot,
    transport: 'test-runtime',
    sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/unrecoverable/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user',
        workspaceId: 'workspace',
        projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
        message: 'continue',
        runtimeConfiguration: {
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com',
          revision: 'test-revision',
        },
      }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json() as { error?: { code?: string } }).error?.code, 'PROVISIONING_FAILED')
    // No replacement workload is created while the old one is still
    // unconfirmed.  The entry remains a capacity barrier until cleanup is
    // retried or the host is shut down.
    assert.equal(creations, 1)
    assert.equal(cleanups, 1)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
  assert.equal(cleanups, 2)
})

test('reserves Agent Host capacity while different sessions are provisioning concurrently', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-capacity-race-test-'))
  let releaseCreate!: () => void
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
  let firstStartedResolve!: () => void
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve })
  const backend: PromptRuntimeBackend = {
    createSession: async (_userId, _workspaceId, sessionId) => {
      if (sessionId === 'first') {
        firstStartedResolve()
        await createGate
      }
      return {
        prompt: async () => new Response(`${JSON.stringify({ type: 'agent_settled', sessionId })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }),
        cleanup: async () => { },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000, maxSessions: 1,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const request = (sessionId: string) => fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'continue',
      runtimeConfiguration: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'test-revision' },
    }),
  })
  try {
    const first = request('first')
    await firstStarted
    const second = await request('second')
    assert.equal(second.status, 409)
    releaseCreate()
    assert.equal((await first).status, 200)
  } finally {
    releaseCreate()
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('cleans a stale Project VM workload before creating a runtime after Agent Host restart', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-restart-cleanup-test-'))
  let creates = 0
  let staleCleanups = 0
  const backend: PromptRuntimeBackend = {
    cleanupSession: async (userId, workspaceId, sessionId, projectId) => {
      assert.equal(userId, 'user')
      assert.equal(workspaceId, 'workspace')
      assert.equal(sessionId, 'restartable')
      assert.equal(projectId, '2c51ca26-3cd0-4cb4-896d-2061de06098c')
      staleCleanups += 1
    },
    createSession: async () => {
      creates += 1
      return {
        prompt: async () => new Response(`${JSON.stringify({ type: 'agent_settled' })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } }),
        cleanup: async () => { },
      }
    },
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const request = () => fetch(`http://127.0.0.1:${address.port}/v1/agent/sessions/restartable/events`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'continue',
      runtimeConfiguration: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', revision: 'restart-test' },
    }),
  })
  try {
    assert.equal((await request()).status, 200)
    assert.equal((await request()).status, 200)
    assert.equal(creates, 1)
    // Cleanup is only needed when the in-memory runtime is first materialised;
    // subsequent turns reuse the same workload.
    assert.equal(staleCleanups, 1)
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('discovers the authenticated Project preview target without exposing it to the public gateway', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-preview-discovery-test-'))
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  const projectRuntimeManager = {
    discoverPreviewTarget: async (id: string) => {
      assert.equal(id, projectId)
      return {
        url: 'http://host.containers.internal:51000/v1/sandboxes/sandbox-1/proxy/5173/',
        headers: { 'OPEN-SANDBOX-API-KEY': 'project-private-key' },
        port: 5173,
        sandboxId: 'sandbox-1',
      }
    },
  } as unknown as ProjectRuntimeManager
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({ prompt: async () => new Response(''), cleanup: async () => { } }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000, projectRuntimeManager,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${projectId}/preview-target`, {
      headers: { Authorization: 'Bearer test-token-which-is-long-enough' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      target: {
        url: 'http://host.containers.internal:51000/v1/sandboxes/sandbox-1/proxy/5173/',
        headers: { 'OPEN-SANDBOX-API-KEY': 'project-private-key' },
        port: 5173,
        sandboxId: 'sandbox-1',
      },
    })
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('exposes only the safe Project Supabase connection material to authenticated callers', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-supabase-route-test-'))
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  let ensuredProject: string | undefined
  const projectRuntimeManager = {
    ensure: async (id: string) => {
      ensuredProject = id
      return {
        supabase: {
          url: 'http://host.containers.internal:51200',
          publishableKey: 'sb_publishable_test-publishable-key',
          anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbm9uIn0.signature',
          revision: '2026.0.0',
        },
      }
    },
  } as unknown as ProjectRuntimeManager
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({ prompt: async () => new Response(''), cleanup: async () => { } }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000, projectRuntimeManager,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    const denied = await fetch(`${endpoint}/v1/projects/${projectId}/supabase`)
    assert.equal(denied.status, 403)

    const ok = await fetch(`${endpoint}/v1/projects/${projectId}/supabase`, {
      headers: { Authorization: 'Bearer test-token-which-is-long-enough' },
    })
    assert.equal(ok.status, 200)
    assert.equal(ensuredProject, projectId)
    const payload = await ok.json() as { supabase?: Record<string, unknown> }
    assert.deepEqual(payload.supabase, {
      url: 'http://host.containers.internal:51200',
      publishableKey: 'sb_publishable_test-publishable-key',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbm9uIn0.signature',
      revision: '2026.0.0',
    })
    // The safe boundary must hold: no service-role key or DB password may ever
    // be exposed through this surface, regardless of what the runtime holds.
    const keys = Object.keys(payload.supabase ?? {})
    assert.ok(!keys.includes('serviceRoleKey'))
    assert.ok(!keys.includes('serviceRole'))
    assert.ok(!keys.includes('databasePassword'))
    assert.ok(!keys.includes('password'))
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('forwards authenticated Project Supabase management operations without exposing credentials', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-supabase-management-route-test-'))
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  let received: unknown
  const projectRuntimeManager = {
    manageSupabase: async (_id: string, request: unknown) => { received = request; return { operation: 'tables', tables: [{ schema: 'public', name: 'profiles', kind: 'BASE TABLE' }] } },
  } as unknown as ProjectRuntimeManager
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({ prompt: async () => new Response(''), cleanup: async () => { } }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000, projectRuntimeManager,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    const denied = await fetch(`${endpoint}/v1/projects/${projectId}/supabase/management`, { method: 'POST', body: JSON.stringify({ operation: 'tables' }) })
    assert.equal(denied.status, 403)
    const invalid = await fetch(`${endpoint}/v1/projects/${projectId}/supabase/management`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'not-an-operation' }),
    })
    assert.equal(invalid.status, 400)
    const ok = await fetch(`${endpoint}/v1/projects/${projectId}/supabase/management`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'tables' }),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { operation: 'tables', tables: [{ schema: 'public', name: 'profiles', kind: 'BASE TABLE' }] })
    assert.deepEqual(received, { operation: 'tables' })
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('forwards an authenticated, bounded Studio proxy request without dashboard credentials', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-supabase-studio-proxy-test-'))
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  let received: unknown
  const projectRuntimeManager = {
    proxySupabaseStudio: async (_id: string, request: unknown) => {
      received = request
      return { status: 200, headers: { 'content-type': 'text/html' }, bodyBase64: Buffer.from('<main>Studio</main>').toString('base64url') }
    },
  } as unknown as ProjectRuntimeManager
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({ prompt: async () => new Response(''), cleanup: async () => { } }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000, projectRuntimeManager,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    const denied = await fetch(`${endpoint}/v1/projects/${projectId}/supabase/studio-proxy`, { method: 'POST', body: JSON.stringify({ method: 'GET', path: '/' }) })
    assert.equal(denied.status, 403)
    const invalid = await fetch(`${endpoint}/v1/projects/${projectId}/supabase/studio-proxy`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path: 'https://example.com/' }),
    })
    assert.equal(invalid.status, 400)
    const ok = await fetch(`${endpoint}/v1/projects/${projectId}/supabase/studio-proxy`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'GET', path: '/projects/default/editor', headers: { accept: 'text/html' } }),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { status: 200, headers: { 'content-type': 'text/html' }, bodyBase64: Buffer.from('<main>Studio</main>').toString('base64url') })
    assert.deepEqual(received, { method: 'GET', path: '/projects/default/editor', headers: { accept: 'text/html' } })
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('reports a null Project Supabase backend when the runtime has none provisioned', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-supabase-null-test-'))
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  const projectRuntimeManager = {
    ensure: async () => ({}),
  } as unknown as ProjectRuntimeManager
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({ prompt: async () => new Response(''), cleanup: async () => { } }),
    close: async () => { },
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot,
    transport: 'test-runtime', sessionIdleTtlMs: 60_000, projectRuntimeManager,
  }, backend)
  const address = runtime.server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${projectId}/supabase`, {
      headers: { Authorization: 'Bearer test-token-which-is-long-enough' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { supabase: null })
  } finally {
    runtime.server.close()
    await once(runtime.server, 'close')
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
