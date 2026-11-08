import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'

const source = readFileSync(new URL('../../app/api/chat/[session_id]/git/binding/route.ts', import.meta.url), 'utf8')
const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
const ref = 'a'.repeat(40)

function fixture({ user = 'user-id', chat = true, runtimeMode = 'local', hostRequest } = {}) {
  const calls = []
  const commonjsModule = { exports: {} }
  const modules = {
    '@/lib/chat-sessions': {
      isChatSessionId: () => true,
      getChatSession: async (_supabase, userId, sessionId) => chat
        ? { id: sessionId, user_id: userId, project_id: 'project-id', workspace_id: 'workspace-id' }
        : null,
    },
    '@/lib/runtime-mode.server': { getRuntimeMode: () => runtimeMode },
    '@/utils/supabase/server': {
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user ? { id: user } : null } }) } }),
    },
  }
  const defaultHostFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null })
    return Response.json({ binding: { ref, workspacePath: '/private/project/worktree' } })
  }
  new Function('require', 'module', 'exports', 'process', 'fetch', code)(
    name => modules[name], commonjsModule, commonjsModule.exports,
    { env: { OPENLINK_AGENT_HOST_URL: 'http://agent-host.local', OPENLINK_AGENT_API_TOKEN: 'private-token' } },
    hostRequest || defaultHostFetch,
  )
  const origin = 'http://openlink.local'
  return {
    calls,
    get: () => commonjsModule.exports.GET(new Request(`${origin}/api/chat/chat-id/git/binding`), { params: Promise.resolve({ session_id: 'chat-id' }) }),
    post: (body, requestOrigin = origin) => commonjsModule.exports.POST(new Request(`${origin}/api/chat/chat-id/git/binding`, {
      method: 'POST',
      headers: { origin: requestOrigin, 'sec-fetch-site': requestOrigin === origin ? 'same-origin' : 'cross-site', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ session_id: 'chat-id' }) }),
  }
}

test('binding GET is owner-scoped and never exposes host paths', async () => {
  const f = fixture()
  const response = await f.get()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { binding: { ref } })
  assert.match(f.calls[0].url, /userId=user-id/)
  assert.match(f.calls[0].url, /workspaceId=workspace-id/)
  assert.match(f.calls[0].url, /projects%2Fproject-id|projects\/project-id/)
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer private-token')
})

test('binding POST derives project identity from the authenticated chat and rejects cross-origin or invalid refs', async () => {
  const f = fixture()
  const response = await f.post({ ref, projectId: 'attacker-project', userId: 'attacker-user' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { binding: { ref } })
  assert.deepEqual(f.calls[0].body, { userId: 'user-id', workspaceId: 'workspace-id', sessionId: 'chat-id', ref })

  const crossOrigin = fixture()
  assert.equal((await crossOrigin.post({ ref }, 'https://attacker.example')).status, 403)
  assert.equal(crossOrigin.calls.length, 0)

  const invalidRef = fixture()
  assert.equal((await invalidRef.post({ ref: 'main' })).status, 400)
  assert.equal(invalidRef.calls.length, 0)
})

test('cloud and unauthenticated chats cannot create a local Git worktree binding', async () => {
  const cloud = fixture({ runtimeMode: 'cloud' })
  assert.deepEqual(await (await cloud.get()).json(), { binding: null })
  assert.equal(cloud.calls.length, 0)

  const unauthenticated = fixture({ user: null })
  assert.equal((await unauthenticated.post({ ref })).status, 401)
  assert.equal(unauthenticated.calls.length, 0)
})
