import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const routeSource = readFileSync(new URL('../../app/api/chat/[session_id]/queue/route.ts', import.meta.url), 'utf8')
const routeCompiled = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(options = {}) {
  const calls = []
  const inserted = []
  const query = {
    operation: 'select',
    select(columns) { calls.push(['select', columns]); return this },
    insert(value) { this.operation = 'insert'; inserted.push(value); return this },
    delete() { this.operation = 'delete'; return this },
    update(value) { this.operation = 'update'; calls.push(['update', value]); return this },
    eq(column, value) { calls.push(['eq', column, value]); return this },
    is(column, value) { calls.push(['is', column, value]); return this },
    order(column) { calls.push(['order', column]); return this },
    single() { return Promise.resolve(options.insertResult ?? { data: { ...inserted.at(-1), claim_token: null, claim_expires_at: null, created_at: '2026-09-08T00:00:00Z' }, error: null }) },
    then(resolve) {
      const result = this.operation === 'select'
        ? (options.selectResult ?? { data: [], error: null })
        : (options.mutationResult ?? { data: [{ id: 'queue-id' }], error: null })
      this.operation = 'select'
      return Promise.resolve(result).then(resolve)
    },
  }
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-id' } } }) },
    schema() { return this },
    from(table) { calls.push(['from', table]); return query },
    rpc: async (name, args) => {
      calls.push(['rpc', name, args])
      if (name === 'enqueue_chat_prompt') {
        inserted.push({ id: args.p_id, session_id: args.p_session_id, user_id: args.p_user_id, message: args.p_message, attachments: args.p_attachments, provider_id: args.p_provider_id, model_id: args.p_model_id })
        return options.enqueueResult ?? { data: [{ ...inserted.at(-1), claim_token: null, claim_expires_at: null, created_at: '2026-09-08T00:00:00Z' }], error: null }
      }
      if (name === 'claim_next_chat_prompt') return options.rpcResult ?? { data: [], error: null }
      return options.mutationResult ?? { data: true, error: null }
    },
  }
  const modules = {
    'node:crypto': { randomBytes: () => Buffer.from('deterministic-claim-token') },
    '@/lib/agent-runtime/prompt-attachments': {
      parsePromptAttachments: (value) => value === undefined ? [] : Array.isArray(value) ? value : null,
    },
    '@/lib/chat-session-uploads.server': { resolvePromptFileAttachments: async (_db, _session, _user, attachments) => attachments },
    '@/lib/chat-sessions': { isChatSessionId: () => true, getChatSession: async () => ({ id: 'session' }) },
    '@/utils/supabase/server': { createClient: async () => db },
  }
  const exports = {}
  new Function('require', 'exports', routeCompiled)((id) => { assert.ok(id in modules, id); return modules[id] }, exports)
  const invoke = (method, body, suffix = '') => exports[method](new Request(`http://app.test/api/chat/session/queue${suffix}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  }), { params: Promise.resolve({ session_id: 'session' }) })
  return { invoke, calls, inserted }
}

test('queue insertion persists attachments and the exact selected model', async () => {
  const app = harness()
  const response = await app.invoke('POST', {
    id: '123e4567-e89b-42d3-a456-426614174000',
    message: 'follow up',
    attachments: [{ type: 'reference', referenceType: 'file', name: 'a', path: '/a' }],
    model: { providerId: 'openai', modelId: 'gpt-test' },
  })
  assert.equal(response.status, 201)
  assert.deepEqual(app.inserted[0], {
    id: '123e4567-e89b-42d3-a456-426614174000', session_id: 'session', user_id: 'user-id', message: 'follow up',
    attachments: [{ type: 'reference', referenceType: 'file', name: 'a', path: '/a' }], provider_id: 'openai', model_id: 'gpt-test',
  })
})

test('queue listing distinguishes a live claim from an expired recoverable claim', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const past = new Date(Date.now() - 60_000).toISOString()
  const rows = [future, past].map((expires, index) => ({
    id: `item-${index}`, message: `message-${index}`, attachments: [], provider_id: null, model_id: null,
    claim_token: 'private-token', claim_expires_at: expires, created_at: '2026-09-08T00:00:00Z',
  }))
  const response = await harness({ selectResult: { data: rows, error: null } }).invoke('GET')
  const payload = await response.json()
  assert.deepEqual(payload.items.map((item) => item.claimed), [true, false])
  assert.equal(JSON.stringify(payload).includes('private-token'), false)
})

test('claim is atomic and returns the private completion token only to the drainer', async () => {
  const row = { id: 'item', message: 'next', attachments: [], provider_id: 'p', model_id: 'm', claim_token: 'stored', claim_expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: '2026-09-08T00:00:00Z' }
  const app = harness({ rpcResult: { data: [row], error: null } })
  const response = await app.invoke('PATCH', { action: 'claim' })
  const payload = await response.json()
  assert.equal(payload.item.text, 'next')
  assert.ok(payload.item.claimToken.length >= 16)
  assert.equal(app.calls.some((call) => call[0] === 'rpc' && call[1] === 'claim_next_chat_prompt'), true)
})

test('composer completes only after a canonical message receipt and releases otherwise', () => {
  const ui = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
  assert.match(ui, /event\.type === 'message\.user' && !accepted/)
  assert.match(ui, /accepted = true\s+options\?\.onAccepted\?\.\(\)/)
  assert.match(ui, /receiptCompletion \?\?= finishClaim\(true\)/)
  assert.match(ui, /else await finishClaim\(accepted\)/)
  assert.match(ui, /\/queue.*method: 'POST'/s)
  assert.match(ui, /rounded-t-xl border border-b-0/, 'queue remains attached to the input as a half frame')
})

test('composer waits for authoritative worker idleness before draining after reload', () => {
  const ui = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
  assert.match(ui, /setRuntimeBusy\(typeof payload\?\.result\?\.busy === 'boolean'/)
  assert.match(ui, /if \(runtimeBusy !== true\) return[\s\S]*runControl\('status'\)/)
  assert.match(ui, /status !== 'idle' \|\| runtimeBusy !== false \|\| !next/)
})

test('migration binds queue ownership and claims only the oldest recoverable item', () => {
  const sql = readFileSync(new URL('../../zorkerbase/migrations/20260908110000_chat_session_prompt_queue.sql', import.meta.url), 'utf8')
  assert.match(sql, /foreign key \(session_id, user_id\)/)
  assert.match(sql, /order by queue\.created_at, queue\.id/)
  assert.match(sql, /queue\.claim_token is null or queue\.claim_expires_at <= now\(\)/)
  assert.match(sql, /for update skip locked/)
})
