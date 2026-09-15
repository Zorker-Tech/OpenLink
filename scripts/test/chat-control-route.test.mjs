import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const code = ts.transpileModule(readFileSync(new URL('../../app/api/chat/[session_id]/control/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function harness({ user = 'owner', agent = 'codex', sessionExists = true, host = async () => Response.json({ result: { mode: 'plan' } }) } = {}) {
  const exports = {}
  const calls = []
  const forkedEvents = []
  const deleted = []
  const modules = {
    '@/lib/chat-sessions': {
      isChatSessionId: () => true,
      getChatSession: async () => sessionExists ? { id: 'session', user_id: 'owner', workspace_id: 'workspace', project_id: 'project', agent } : null,
      forkChatSession: async () => ({ id: 'AbCdEf12345' }),
      deleteChatSession: async (_db, _user, id) => { deleted.push(id) },
    },
    '@/utils/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user ? { id: user } : null } }) } }) },
    '@/lib/chat-session-persistence.server': { parsePiSessionDelta: () => null, persistPiSessionDelta: async () => {}, forkPersistedChatEvents: async (_db, _user, source, target) => { forkedEvents.push([source, target]) } },
  }
  new Function('require', 'exports', 'fetch', 'process', code)(name => modules[name], exports, async (url, input) => { calls.push(JSON.parse(input.body)); return host() }, { env: { OPENLINK_AGENT_HOST_URL: 'http://host', OPENLINK_AGENT_API_TOKEN: 'private' } })
  return { calls, deleted, forkedEvents, send: (body) => exports.POST(new Request('http://app/control', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ session_id: 'session' }) }) }
}
test('session control authenticates and resolves ownership before Host mutation', async () => {
  for (const options of [{ user: null }, { sessionExists: false }]) {
    const h = harness(options)
    assert.ok([401, 404].includes((await h.send({ action: 'pause' })).status))
    assert.equal(h.calls.length, 0)
  }
})
test('control cannot override trusted session identity or invoke arbitrary RPC', async () => {
  const h = harness()
  assert.equal((await h.send({ action: 'plan', userId: 'other', workspaceId: 'other', sessionId: 'other' })).status, 200)
  assert.equal(h.calls[0].userId, 'owner')
  assert.equal(h.calls[0].sessionId, 'session')
  assert.equal(h.calls[0].workspaceId, 'workspace')
  assert.equal((await h.send({ action: 'command/exec', text: 'command' })).status, 400)
  assert.equal(h.calls.length, 1)
})
test('unsupported Pi modes and invalid steering inputs are rejected before forwarding', async () => {
  const h = harness({ agent: 'pi' })
  assert.equal((await h.send({ action: 'goal', text: 'test' })).status, 400)
  assert.equal((await h.send({ action: 'steer', text: '' })).status, 400)
  assert.equal(h.calls.length, 0)
})
test('Host failures are not success and private diagnostics remain private', async () => {
  const h = harness({ host: async () => Response.json({ error: { message: 'private-key', code: 'INVALID_BODY' } }, { status: 400 }) })
  const response = await h.send({ action: 'plan' })
  assert.equal(response.status, 400)
  assert.doesNotMatch(await response.text(), /private-key/)
})

test('fork clones visible history, binds the native target, and returns its trusted path', async () => {
  const h = harness({ host: async () => Response.json({ result: { forked: true, threadId: 'native-child' } }) })
  const response = await h.send({ action: 'fork', targetSessionId: 'attacker' })
  assert.equal(response.status, 200)
  assert.deepEqual(h.forkedEvents, [['session', 'AbCdEf12345']])
  assert.equal(h.calls[0].targetSessionId, 'AbCdEf12345')
  assert.deepEqual((await response.json()).fork, { id: 'AbCdEf12345', path: '/owner/chat/AbCdEf12345' })
})

test('failed native fork deletes the provisional target chat', async () => {
  const h = harness({ host: async () => Response.json({ error: true }, { status: 400 }) })
  assert.equal((await h.send({ action: 'fork' })).status, 400)
  assert.deepEqual(h.deleted, ['AbCdEf12345'])
})
