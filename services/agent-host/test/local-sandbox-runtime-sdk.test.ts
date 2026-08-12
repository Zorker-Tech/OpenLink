import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DesktopSandboxRuntimeNodeBackend } from '../src/backends/local-sandbox-runtime-sdk.js'
import type { SandboxRuntimeAdapter } from '../src/backends/local-sandbox-runtime.js'

const workerScript = [
  "const http = require('node:http')",
  "const server = http.createServer((request, response) => { if (request.url === '/healthz') { response.writeHead(200); response.end('ok'); return } response.writeHead(404); response.end() })",
  "server.listen(Number(process.env.OPENLINK_AGENT_WORKER_PORT), process.env.OPENLINK_AGENT_WORKER_HOST)",
].join(';')

function runtimeConfig(apiKey: string) {
  return {
    providerId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    apiKey,
    baseUrl: 'https://api.deepseek.com',
    revision: 'test-revision',
  }
}

test('desktop sandbox-runtime serializes provider setup and rejects a second active session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-desktop-runtime-test-'))
  let initializeStarted!: () => void
  const started = new Promise<void>((resolve) => { initializeStarted = resolve })
  const seenKeys: string[] = []
  let resets = 0
  const adapter: SandboxRuntimeAdapter = {
    initialize: async () => {
      seenKeys.push(process.env.OPENLINK_PROVIDER_API_KEY ?? '')
      initializeStarted()
      await new Promise((resolve) => setTimeout(resolve, 20))
    },
    wrapWithSandboxArgv: async () => ({
      argv: [process.execPath, '-e', workerScript],
      env: { ...process.env },
    }),
    reset: async () => { resets += 1 },
  }
  const backend = new DesktopSandboxRuntimeNodeBackend(adapter, {
    workerEntrypoint: join(root, 'unused-worker.mjs'),
    workspaceRoot: root,
    storageRoot: join(root, 'storage'),
    policy: { allowedDomains: [], deniedDomains: [], allowWrite: [], denyWrite: [], denyRead: [], allowUnixSockets: [] },
  })

  try {
    const first = backend.createSession('user', 'workspace', 'session-one', runtimeConfig('key-one'))
    await started
    await assert.rejects(
      backend.createSession('user', 'workspace', 'session-two', runtimeConfig('key-two')),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SESSION_BUSY',
    )

    const session = await first
    assert.deepEqual(seenKeys, ['key-one'])
    await session.cleanup()
    assert.equal(resets, 1)

    const second = await backend.createSession('user', 'workspace', 'session-two', runtimeConfig('key-two'))
    assert.deepEqual(seenKeys, ['key-one', 'key-two'])
    await second.cleanup()
    assert.equal(resets, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

