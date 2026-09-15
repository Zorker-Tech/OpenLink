import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../../app/api/chat/[session_id]/title/route.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function fixture({ agent = 'codex', title = 'original prompt', authenticated = true, renameDuringGeneration = false } = {}) {
  const row = { id: 'session', user_id: 'user', workspace_id: 'workspace', project_id: 'project',
    initial_prompt: 'original prompt', title, agent, updated_at: 'before' }
  let calls = 0
  const filters = {}
  let patch
  const query = {
    update(value) { patch = value; return this },
    eq(key, value) { filters[key] = value; return this },
    select() { return this },
    async maybeSingle() {
      if (!Object.entries(filters).every(([key, value]) => row[key] === value)) return { data: null }
      Object.assign(row, patch)
      return { data: { title: row.title } }
    },
  }
  const db = {
    auth: { getUser: async () => ({ data: { user: authenticated ? { id: 'user' } : null } }) },
    schema: () => ({ from: () => query }),
  }
  const modules = {
    '@/utils/supabase/server': { createClient: async () => db },
    '@/lib/chat-sessions': { isChatSessionId: () => true, getChatSession: async () => ({ ...row }), deriveChatSessionTitle: (text) => text },
    '@/lib/chat-session-persistence.server': { findFirstPersistedUserMessage: async () => ({ type: 'message.user', text: row.initial_prompt }) },
  }
  const exports = {}
  new Function('require', 'exports', 'fetch', 'process', compiled)(
    (id) => modules[id], exports,
    async (url, options) => {
      calls++
      assert.equal(new URL(url).searchParams.has('query'), false, 'prompt must not leak through URL access logs')
      const body = JSON.parse(options.body)
      assert.equal(body.titlePrompt, row.initial_prompt)
      assert.equal(body.runtimeConfiguration, undefined, 'metadata must not create another Worker')
      if (renameDuringGeneration) Object.assign(row, { title: 'my manual title', updated_at: 'after' })
      return Response.json({ title: '生成的标题' })
    },
    { env: { OPENLINK_AGENT_HOST_URL: 'http://host.test', OPENLINK_AGENT_API_TOKEN: 'test' } },
  )
  return { row, calls: () => calls,
    send: async () => exports.POST(new Request('http://app.test/api/chat/session/title', { method: 'POST' }),
      { params: Promise.resolve({ session_id: 'session' }) }) }
}

test('generated title is persisted through the authenticated session boundary', async () => {
  const f = fixture()
  assert.deepEqual(await (await f.send()).json(), { title: '生成的标题' })
  assert.equal(f.row.title, '生成的标题')
})

test('concurrent manual rename wins against generated title', async () => {
  const f = fixture({ renameDuringGeneration: true })
  assert.deepEqual(await (await f.send()).json(), { title: null })
  assert.equal(f.row.title, 'my manual title')
})

test('Pi and manually named sessions never invoke the generator', async () => {
  for (const options of [{ agent: 'pi' }, { title: 'my manual title' }]) {
    const f = fixture(options)
    await f.send()
    assert.equal(f.calls(), 0)
  }
})

test('unauthenticated clients cannot generate or change titles', async () => {
  const f = fixture({ authenticated: false })
  assert.equal((await f.send()).status, 401)
  assert.equal(f.calls(), 0)
})
