import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleSupabaseMcpRequest, mintSupabaseMcpToken, verifySupabaseMcpToken } from '../src/supabase-mcp.js'

const secret = 'test-secret-for-supabase-mcp'
const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'

function stubPair(body: unknown, headers: Record<string, string> = {}): { request: IncomingMessage; response: ServerResponse; done: Promise<{ status: number; body: string }> } {
  const request = new PassThrough() as unknown as IncomingMessage
  const chunks: Buffer[] = []
  let status = 0
  let settled: (value: { status: number; body: string }) => void
  const done = new Promise<{ status: number; body: string }>((resolve) => { settled = resolve })
  const response = {
    writeHead(statusCode: number, _headers?: unknown) { status = statusCode; return response },
    end(payload?: unknown) {
      if (payload !== undefined) chunks.push(Buffer.from(String(payload)))
      settled({ status, body: Buffer.concat(chunks).toString('utf8') })
      return response
    },
  } as unknown as ServerResponse
  request.headers = headers
  request.method = 'POST'
  queueMicrotask(() => {
    for (const chunk of [Buffer.from(JSON.stringify(body))]) request.emit('data', chunk)
    request.emit('end')
  })
  return { request, response, done }
}

test('capability tokens are project-bound and expire', () => {
  const token = mintSupabaseMcpToken(secret, projectId, 60_000)
  assert.equal(verifySupabaseMcpToken(secret, token, projectId), true)
  assert.equal(verifySupabaseMcpToken(secret, token, 'other-project'), false, 'must be bound to the minted project')
  assert.equal(verifySupabaseMcpToken(secret, token.slice(0, -2) + 'xx', projectId), false, 'signature must be enforced')
  assert.equal(verifySupabaseMcpToken(secret, token, projectId, Date.now() + 120_000), false, 'expired tokens must be rejected')
})

const internalHeaders = { authorization: `Bearer ${secret}` }
test('initialize and tools/list speak MCP JSON-RPC', async () => {
  const calls: Array<{ operation: string }> = []
  const init = stubPair({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, internalHeaders)
  await handleSupabaseMcpRequest({
    request: init.request, response: init.response, projectId, apiToken: secret,
    manage: async (operation) => { calls.push({ operation }); return {} },
    resolveAccessMode: async () => 'restricted',
  })
  const initialized = JSON.parse((await init.done).body)
  assert.equal(initialized.result.serverInfo.name, 'openlink-project-supabase')
  assert.equal(initialized.result.protocolVersion, '2025-06-18')

  const list = stubPair({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, internalHeaders)
  await handleSupabaseMcpRequest({
    request: list.request, response: list.response, projectId, apiToken: secret,
    manage: async () => ({}),
    resolveAccessMode: async () => 'restricted',
  })
  const tools = JSON.parse((await list.done).body).result.tools
  assert.ok(Array.isArray(tools) && tools.length >= 9, 'must advertise the management tools')
  assert.equal(tools.find((tool: { name: string }) => tool.name === 'supabase_database_info')?.annotations?.readOnlyHint, true)
  assert.equal(tools.find((tool: { name: string }) => tool.name === 'supabase_execute_sql')?.annotations?.readOnlyHint, false)
  assert.equal(calls.length, 0, 'tools/list must not execute management operations')
})

test('tools/call executes the management operation with capability auth', async () => {
  const token = mintSupabaseMcpToken(secret, projectId, 60_000)
  const seen: Array<{ operation: string; query?: string }> = []
  const call = stubPair({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'supabase_execute_sql', arguments: { query: 'select 1' } } })
  call.request.headers = { authorization: `Bearer ${token}` }
  await handleSupabaseMcpRequest({
    request: call.request, response: call.response, projectId, apiToken: secret,
    manage: async (operation, extra) => {
      seen.push({ operation, query: extra.query })
      return { query: 'ok' }
    },
    resolveAccessMode: async () => 'restricted',
  })
  const payload = JSON.parse((await call.done).body)
  assert.deepEqual(seen, [{ operation: 'query', query: 'select 1' }])
  assert.equal(payload.result.content[0].text, JSON.stringify({ query: 'ok' }))

  // A capability minted for another project must not manage this one.
  const foreign = stubPair({ jsonrpc: '2.0', id: 'b', method: 'tools/list' })
  foreign.request.headers = { authorization: `Bearer ${mintSupabaseMcpToken(secret, 'other-project', 60_000)}` }
  await handleSupabaseMcpRequest({
    request: foreign.request, response: foreign.response, projectId, apiToken: secret,
    manage: async () => ({}),
    resolveAccessMode: async () => 'restricted',
  })
  assert.equal((await foreign.done).status, 403)
})

test('unknown tools are rejected; statements forward to the VM controller', async () => {
  const unknown = stubPair({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'supabase_drop_everything' } }, { authorization: `Bearer ${secret}` })
  await handleSupabaseMcpRequest({
    request: unknown.request, response: unknown.response, projectId, apiToken: secret,
    manage: async () => ({}),
    resolveAccessMode: async () => 'restricted',
  })
  assert.equal(JSON.parse((await unknown.done).body).error.code, -32602)

  // Restricted mode denies writes at the firewall before touching the VM.
  const write = stubPair({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'supabase_execute_sql', arguments: { query: 'delete from t' } } }, { authorization: `Bearer ${secret}` })
  let executed = false
  await handleSupabaseMcpRequest({
    request: write.request, response: write.response, projectId, apiToken: secret,
    manage: async () => { executed = true; return {} },
    resolveAccessMode: async () => 'restricted',
  })
  const denied = JSON.parse((await write.done).body)
  assert.equal(denied.error?.code, -32000, 'writes must be denied in restricted mode')
  assert.equal(executed, false, 'must never reach the VM controller')

  // Open mode executes the write directly.
  const writeOpen = stubPair({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'supabase_execute_sql', arguments: { query: 'create table t (id int)' } } }, { authorization: `Bearer ${secret}`, 'x-openlink-session-id': 'open-session' })
  let openExecuted = false
  await handleSupabaseMcpRequest({
    request: writeOpen.request, response: writeOpen.response, projectId, apiToken: secret,
    manage: async (operation, extra) => { openExecuted = true; return { operation, mode: extra.mode } },
    resolveAccessMode: async () => 'open',
  })
  assert.equal(openExecuted, true, 'open mode must allow writes')
  assert.equal(JSON.parse((await writeOpen.done).body).result.isError ?? false, false)

  // Ask mode returns a pending confirmation and does not execute.
  const ask = stubPair({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'supabase_execute_sql', arguments: { query: 'drop table auth.users' } } }, { authorization: `Bearer ${secret}` })
  ask.request.headers = { authorization: `Bearer ${secret}`, 'x-openlink-session-id': 'ask-session' }
  let askExecuted = false
  await handleSupabaseMcpRequest({
    request: ask.request, response: ask.response, projectId, apiToken: secret,
    manage: async () => { askExecuted = true; return {} },
    resolveAccessMode: async () => 'ask',
  })
  const askBody = JSON.parse((await ask.done).body)
  assert.equal(askExecuted, false)
  assert.match(JSON.stringify(askBody), /confirmation_required/)
})
