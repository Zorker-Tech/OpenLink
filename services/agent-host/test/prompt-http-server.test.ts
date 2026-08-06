import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startPromptHttpServer, type PromptRuntimeBackend } from '../src/prompt-http-server.js'

test('prompt server authenticates, streams NDJSON, and enforces runtime capacity', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-server-test-'))
  let closes = 0
  const backend: PromptRuntimeBackend = {
    createSession: async (_userId, _workspaceId, sessionId) => ({
      prompt: async (message) => new Response(`${JSON.stringify({ type: 'echo', sessionId, message })}\n`, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
      cleanup: async () => { closes += 1 },
    }),
    close: async () => {},
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
      body: JSON.stringify({ userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello' }),
    })
    assert.equal(denied.status, 403)

    const accepted = await fetch(`${endpoint}/v1/agent/sessions/one/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello' }),
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.headers.get('x-openlink-agent-transport'), 'test-runtime')
    assert.deepEqual(JSON.parse((await accepted.text()).trim()), { type: 'echo', sessionId: 'one', message: 'hello' })

    const capacity = await fetch(`${endpoint}/v1/agent/sessions/two/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', message: 'hello' }),
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

test('prompt server forwards the selected provider and Pi-native Cloud session snapshot', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-prompt-native-session-test-'))
  let captured: Parameters<PromptRuntimeBackend['createSession']> | undefined
  const backend: PromptRuntimeBackend = {
    createSession: async (...parameters) => {
      captured = parameters
      return {
        prompt: async () => new Response(`${JSON.stringify({ type: 'agent_settled' })}\n`),
        cleanup: async () => {},
      }
    },
    close: async () => {},
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
