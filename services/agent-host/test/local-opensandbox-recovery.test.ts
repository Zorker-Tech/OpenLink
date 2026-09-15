import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureProviderCredentialVault, ensureRecoveredWorkerProcess, projectContainerReachableUrl, waitForWorker, requestWorkerPrompt } from '../src/backends/local-opensandbox.js'

test('cancellation reaches a Worker whose response headers have not arrived', async () => {
  const original = globalThis.fetch
  const abort = new AbortController()
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('preparation aborted')), { once: true }))
  try {
    const request = requestWorkerPrompt('http://worker', {}, 'hello', abort.signal)
    abort.abort()
    await assert.rejects(request, /preparation aborted/)
  } finally { globalThis.fetch = original }
})

test('cancellation after Worker headers drains the native response instead of aborting it', async () => {
  const original = globalThis.fetch
  const abort = new AbortController()
  let streamSignal: AbortSignal | undefined
  let canceled = false
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/cancel')) { canceled = true; return new Response('{}') }
    streamSignal = options?.signal as AbortSignal
    return new Response('final native snapshot')
  }
  try {
    const response = await requestWorkerPrompt('http://worker', {}, 'hello', abort.signal)
    abort.abort()
    assert.equal(canceled, true)
    assert.equal(streamSignal?.aborted, false)
    assert.equal(await response.text(), 'final native snapshot')
  } finally { globalThis.fetch = original }
})

test('terminal Worker initialization error is reported without waiting another minute', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ state: 'error', error: 'native model is unavailable' }, { status: 503 }) }
  try {
    await assert.rejects(waitForWorker('http://worker'), /native model is unavailable/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

test('rewrites host loopback services for project sandbox containers only', () => {
  const runtime = { status: 'ready' } as never
  assert.equal(
    projectContainerReachableUrl('http://127.0.0.1:43121/v1/projects/p1/supabase/mcp', runtime),
    'http://host.containers.internal:43121/v1/projects/p1/supabase/mcp',
  )
  assert.equal(
    projectContainerReachableUrl('http://localhost:54002', runtime),
    'http://host.containers.internal:54002',
  )
  assert.equal(
    projectContainerReachableUrl('http://127.0.0.1:43121/path'),
    'http://127.0.0.1:43121/path',
  )
})

test('reattaches a healthy Agent Worker without launching a duplicate process', async () => {
  let launches = 0
  const sandbox = {
    commands: {
      run: async () => {
        launches += 1
        return { id: 'unexpected' }
      },
    },
  }
  const result = await ensureRecoveredWorkerProcess(
    sandbox as never,
    'http://worker.test',
    {},
    async () => undefined,
  )
  assert.equal(result, 'running')
  assert.equal(launches, 0)
})

test('restarts the Agent Worker inside its existing sandbox after a VM reboot', async () => {
  const calls: Array<{ command: string; options: unknown }> = []
  let probes = 0
  const sandbox = {
    commands: {
      run: async (command: string, options: unknown) => {
        calls.push({ command, options })
        return { id: 'recovery-command' }
      },
    },
  }
  const result = await ensureRecoveredWorkerProcess(
    sandbox as never,
    'http://worker.test',
    { 'x-endpoint-token': 'opaque' },
    async (_baseUrl, _headers, timeoutMs) => {
      probes += 1
      if (probes === 1) {
        assert.equal(timeoutMs, 2_000)
        throw new Error('worker process ended with the VM')
      }
      assert.equal(timeoutMs, 60_000)
    },
  )
  assert.equal(result, 'restarted')
  assert.deepEqual(calls, [{
    command: 'exec node /opt/openlink/agent-worker/dist/main.js',
    options: { background: true, workingDirectory: '/workspace' },
  }])
})

test('recreates the provider Credential Vault after an egress sidecar reboot', async () => {
  const calls: Array<{ operation: string; request?: unknown }> = []
  const vault = {
    create: async (request: unknown) => {
      calls.push({ operation: 'create', request })
    },
    delete: async () => {
      calls.push({ operation: 'delete' })
    },
  }
  const result = await ensureProviderCredentialVault(
    vault,
    'https://opencode.ai/zen/go/v1',
    ['opencode.ai'],
    'current-secret',
  )
  assert.equal(result, 'created')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    operation: 'create',
    request: {
      credentials: [{ name: 'provider-api-key', source: { type: 'inline', value: 'current-secret' } }],
      bindings: [{
        name: 'provider-api',
        match: { schemes: ['https'], hosts: ['opencode.ai'] },
        auth: {
          type: 'passthrough',
          substitutions: [{ credential: 'provider-api-key', placeholder: 'openlink-provider-vault-placeholder', in: ['header'] }],
        },
      }],
    },
  })
})

test('replaces a live provider Credential Vault with current credentials', async () => {
  const calls: string[] = []
  let creates = 0
  const vault = {
    create: async () => {
      calls.push('create')
      creates += 1
      if (creates === 1) throw Object.assign(new Error('credential vault already exists'), { statusCode: 409 })
    },
    delete: async () => {
      calls.push('delete')
    },
  }
  assert.equal(await ensureProviderCredentialVault(vault, 'http://provider.test/v1', ['provider.test'], 'new-secret'), 'replaced')
  assert.deepEqual(calls, ['create', 'delete', 'create'])
})

test('does not destroy the vault for a non-conflict provisioning failure', async () => {
  let deletes = 0
  const failure = Object.assign(new Error('egress sidecar unavailable'), { statusCode: 503 })
  const vault = {
    create: async () => { throw failure },
    delete: async () => { deletes += 1 },
  }
  await assert.rejects(
    ensureProviderCredentialVault(vault, 'https://provider.test/v1', ['provider.test'], 'secret'),
    (error) => error === failure,
  )
  assert.equal(deletes, 0)
})
