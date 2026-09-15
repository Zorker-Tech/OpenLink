import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { startPromptHttpServer, type PromptRuntimeBackend } from '../src/prompt-http-server.js'
import type { ProjectRuntimeController } from '../src/project-runtime-router.js'

const body = { userId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', sessionId: 'controls', message: 'hello', runtimeConfiguration: { providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test', baseUrl: 'https://api.deepseek.com', revision: 'test' } }
const headers = { Authorization: 'Bearer test-token-which-is-long-enough', 'Content-Type': 'application/json' }

test('interrupt owns the request while project provisioning is still pending', { timeout: 3000 }, async () => {
  const storageRoot = await mkdtemp('/tmp/openlink-cancel-prepare-')
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
  }
  const started = deferred()
  const gate = deferred()
  let created = 0
  const backend: PromptRuntimeBackend = { createSession: async () => { created++; return { prompt: async () => new Response(''), cleanup: async () => {} } }, close: async () => {} }
  const runtime = await startPromptHttpServer({ host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot, transport: 'test', sessionIdleTtlMs: 60000,
    projectRuntimeManager: { ensure: async () => { started.resolve(); await gate.promise; return {} }, prepareSessionStorage: async () => {}, ensureProjectGitRepository: async () => {} } as unknown as ProjectRuntimeController,
  }, backend)
  const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}/v1/agent/sessions/controls`
  try {
    const pending = fetch(`${url}/events`, { method: 'POST', headers, body: JSON.stringify(body) })
    await started.promise
    const canceled = await fetch(`${url}/control`, { method: 'POST', headers, body: JSON.stringify({ ...body, action: 'interrupt' }) })
    assert.equal(canceled.status, 200)
    gate.resolve()
    const result = await pending
    assert.equal(result.status, 400)
    assert.equal((await result.json() as { error: { code: string } }).error.code, 'REQUEST_ABORTED')
    assert.equal(created, 0)
  } finally {
    gate.resolve()
    runtime.server.close()
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('manual pause survives warmups and Host restart until explicit resume', async () => {
  const storageRoot = await mkdtemp('/tmp/openlink-pause-controls-')
  const backend: PromptRuntimeBackend = { createSession: async () => ({ prompt: async () => new Response('done'), control: async () => ({ busy: false }), cleanup: async () => {} }), close: async () => {} }
  const config = { host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot, transport: 'test', sessionIdleTtlMs: 60000 }
  let runtime = await startPromptHttpServer(config, backend)
  const call = (path: string, payload = body) => fetch(`http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}/v1/agent/sessions/controls/${path}`, { method: 'POST', headers, body: JSON.stringify(payload) })
  try {
    assert.equal((await call('lease')).status, 200)
    assert.equal((await call('control', { ...body, action: 'pause' } as typeof body)).status, 200)
    assert.equal((await (await call('lease')).json() as { paused: boolean }).paused, true)
    assert.equal((await call('events')).status, 409)
    runtime.server.close()
    await runtime.shutdown()
    runtime = await startPromptHttpServer(config, backend)
    assert.equal((await (await call('lease')).json() as { paused: boolean }).paused, true)
    assert.equal((await call('control', { ...body, action: 'resume' } as typeof body)).status, 200)
    assert.equal(await (await call('events')).text(), 'done')
    assert.equal((await call('control', { ...body, userId: 'other', action: 'status' } as typeof body)).status, 400)
  } finally {
    runtime.server.close()
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('fork persists the native child thread into the distinct target session root', async () => {
  const storageRoot = await mkdtemp('/tmp/openlink-fork-controls-')
  const persisted: string[] = []
  const nativeThreadId = '11111111-1111-4111-8111-111111111111'
  const backend: PromptRuntimeBackend = {
    createSession: async () => ({
      prompt: async () => new Response('done'),
      control: async ({ action }) => action === 'fork' ? { forked: true, threadId: nativeThreadId } : {},
      cleanup: async () => {},
    }),
    close: async () => {},
  }
  const manager = {
    ensure: async () => ({}), prepareSessionStorage: async () => '', ensureProjectGitRepository: async () => {},
    persistCodexThreadId: async (_project: string, user: string, workspace: string, session: string, thread: string) => { persisted.push(`${user}:${workspace}:${session}:${thread}`) },
  } as unknown as ProjectRuntimeController
  const runtime = await startPromptHttpServer({ host: '127.0.0.1', port: 0, apiToken: 'test-token-which-is-long-enough', storageRoot, transport: 'test', sessionIdleTtlMs: 60000, projectRuntimeManager: manager }, backend)
  const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}/v1/agent/sessions/controls`
  try {
    assert.equal((await fetch(`${url}/lease`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200)
    const response = await fetch(`${url}/control`, { method: 'POST', headers, body: JSON.stringify({ ...body, action: 'fork', targetSessionId: 'AbCdEf12345' }) })
    assert.equal(response.status, 200)
    assert.deepEqual(persisted, [`user:workspace:AbCdEf12345:${nativeThreadId}`])
  } finally {
    runtime.server.close()
    await runtime.shutdown()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
