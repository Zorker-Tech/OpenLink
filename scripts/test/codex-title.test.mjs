import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexAppServerRuntime } from '../../services/agent-worker/dist/codex-runtime.js'

function fixture() {
  const runtime = new CodexAppServerRuntime({
    workspaceRoot: '/workspace', sessionRoot: '/session', codexHome: '/codex',
    codexBin: 'unused', accessMode: 'restricted', providerId: 'test',
    providerBaseUrl: 'https://provider.test/v1', model: 'test/model',
  })
  runtime.threadId = 'main'
  runtime.start = async () => {}
  return runtime
}

test('native title generation uses an isolated structured Codex turn and writes its name', async () => {
  const runtime = fixture()
  const requests = []
  let leaked = 0
  runtime.emitToUi = () => { leaked++; return true }
  runtime.request = async (method, params) => {
    requests.push({ method, params })
    if (method === 'thread/start') return { thread: { id: 'metadata' } }
    if (method === 'turn/start') {
      runtime.onNotification('item/completed', {
        threadId: 'metadata', item: { type: 'agentMessage', text: '{"title":"修复会话初始化"}' },
      })
      runtime.onNotification('turn/completed', { threadId: 'metadata', turn: { status: 'completed' } })
      return { turn: { id: 'title-turn' } }
    }
    return {}
  }
  assert.deepEqual(await runtime.resources({ scope: 'title', query: '修复新建会话时的初始化错误' }), { title: '修复会话初始化' })
  assert.equal(leaked, 0)
  const start = requests.find((request) => request.method === 'thread/start').params
  assert.equal(start.ephemeral, true)
  assert.equal(start.sandbox, 'read-only')
  assert.equal(start.config['features.shell_tool'], false)
  assert.equal(start.config['features.plugins'], false)
  assert.ok(requests.find((request) => request.method === 'turn/start').params.outputSchema)
  assert.deepEqual(requests.find((request) => request.method === 'thread/name/set').params, {
    threadId: 'main', name: '修复会话初始化',
  })
  assert.ok(requests.some((request) => request.method === 'thread/unsubscribe'))
})

test('unsupported title generation returns null without changing the main conversation', async () => {
  const runtime = fixture()
  runtime.request = async () => { throw new Error('unsupported') }
  assert.deepEqual(await runtime.resources({ scope: 'title', query: 'hello' }), { title: null })
  assert.equal(runtime.threadId, 'main')
  assert.equal(runtime.titleListener, undefined)
})

test('title generation is deduplicated while active', async () => {
  const runtime = fixture()
  let calls = 0
  const gate = Promise.withResolvers()
  runtime.generateTitle = async () => { calls++; return gate.promise }
  const first = runtime.resources({ scope: 'title', query: 'hello' })
  const second = runtime.resources({ scope: 'title', query: 'hello' })
  await new Promise((resolve) => setImmediate(resolve))
  gate.resolve('标题')
  assert.deepEqual(await first, { title: '标题' })
  assert.deepEqual(await second, { title: '标题' })
  assert.equal(calls, 1)
})
