import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startPromptHttpServer, type PromptRuntimeBackend } from '../src/prompt-http-server.js'

const PROJECT_ID = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
const CODE_TOKEN = 'code-token-which-is-long-enough'
const SUBSTRATE_TOKEN = 'substrate-token-which-is-long-enough'
const BOT_KEY = 'bot-11111111-1111-4111-8111-111111111111'

function substrateBody(): string {
  return JSON.stringify({
    userId: 'user',
    workspaceId: 'workspace',
    projectId: PROJECT_ID,
    runtimeConfiguration: {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      revision: 'revision',
    },
    agent: 'pi',
    accessMode: 'restricted',
  })
}

test('Bot substrate uses its own token, one sandbox per Bot key, and idempotent release', async (context) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'openlink-bot-substrate-'))
  context.after(async () => { await rm(storageRoot, { recursive: true, force: true }) })
  const created: string[] = []
  const cleaned: string[] = []
  const backend: PromptRuntimeBackend = {
    createSession: async (_userId, _workspaceId, sessionId) => {
      created.push(sessionId)
      return {
        sandboxId: `sandbox-${sessionId}`,
        prompt: async () => new Response(),
        workerEndpoint: async () => ({
          url: `http://worker/${sessionId}`,
          headers: { 'X-OpenLink-Agent-Worker-Token': 'worker-token' },
        }),
        desktopEndpoint: async () => ({ url: `http://desktop/${sessionId}/vnc.html` }),
        cleanup: async () => { cleaned.push(sessionId) },
      }
    },
    close: async () => {},
  }
  const runtime = await startPromptHttpServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: CODE_TOKEN,
    substrateApiToken: SUBSTRATE_TOKEN,
    storageRoot,
    transport: 'test',
    sessionIdleTtlMs: 60_000,
  }, backend)
  context.after(async () => { runtime.server.close(); await runtime.shutdown() })
  const address = runtime.server.address() as AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  const ensureUrl = `${base}/v1/substrate/bots/${BOT_KEY}/ensure`
  const substrateHeaders = { Authorization: `Bearer ${SUBSTRATE_TOKEN}`, 'Content-Type': 'application/json' }

  const codeDenied = await fetch(ensureUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CODE_TOKEN}`, 'Content-Type': 'application/json' },
    body: substrateBody(),
  })
  assert.equal(codeDenied.status, 403)

  const wrongToken = await fetch(ensureUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
    body: substrateBody(),
  })
  assert.equal(wrongToken.status, 403)

  const ensured = await fetch(ensureUrl, { method: 'POST', headers: substrateHeaders, body: substrateBody() })
  assert.equal(ensured.status, 200)
  const payload = await ensured.json() as Record<string, any>
  assert.equal(payload.ok, true)
  assert.equal(payload.boxKey, BOT_KEY)
  assert.equal(payload.sandboxId, `sandbox-${BOT_KEY}`)
  assert.equal(payload.workerUrl, `http://worker/${BOT_KEY}`)
  assert.equal(payload.workerHeaders['X-OpenLink-Agent-Worker-Token'], 'worker-token')
  assert.match(String(payload.desktopUrl), new RegExp(`/v1/desktop/gateway/sessions/${BOT_KEY}/`))
  assert.equal(payload.vncUrl, `http://desktop/${BOT_KEY}/vnc.html`)
  assert.equal(payload.created, true)
  assert.deepEqual(created, [BOT_KEY])

  const again = await fetch(ensureUrl, { method: 'POST', headers: substrateHeaders, body: substrateBody() })
  assert.equal(again.status, 200)
  assert.equal((await again.json() as Record<string, any>).created, false)
  assert.deepEqual(created, [BOT_KEY])

  const desktop = await fetch(`${base}/v1/substrate/bots/${BOT_KEY}/desktop`, {
    method: 'POST',
    headers: substrateHeaders,
    body: substrateBody(),
  })
  assert.equal(desktop.status, 200)
  assert.match(String((await desktop.json() as Record<string, any>).desktopUrl), new RegExp(`/v1/desktop/gateway/sessions/${BOT_KEY}/`))

  const codeLease = await fetch(`${base}/v1/agent/sessions/${BOT_KEY}/lease`, {
    method: 'POST',
    headers: substrateHeaders,
    body: JSON.stringify({
      userId: 'user',
      workspaceId: 'workspace',
      projectId: PROJECT_ID,
      sessionId: BOT_KEY,
      runtimeConfiguration: {
        providerId: 'deepseek',
        modelId: 'deepseek-v4-flash',
        apiKey: 'test-key',
        baseUrl: 'https://api.deepseek.com',
        revision: 'revision',
      },
    }),
  })
  assert.equal(codeLease.status, 403)

  const released = await fetch(`${base}/v1/substrate/bots/${BOT_KEY}`, {
    method: 'DELETE',
    headers: substrateHeaders,
    body: JSON.stringify({ userId: 'user', workspaceId: 'workspace' }),
  })
  assert.equal(released.status, 200)
  assert.deepEqual(await released.json(), { ok: true, released: true })
  assert.deepEqual(cleaned, [BOT_KEY])

  const releasedAgain = await fetch(`${base}/v1/substrate/bots/${BOT_KEY}`, {
    method: 'DELETE',
    headers: substrateHeaders,
    body: JSON.stringify({ userId: 'user', workspaceId: 'workspace' }),
  })
  assert.equal(releasedAgain.status, 200)
  assert.deepEqual(await releasedAgain.json(), { ok: true, released: false })
})
