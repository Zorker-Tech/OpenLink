import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

// Execute the real route with deterministic DB/Host boundaries. In particular
// the Host promise stays unresolved until after we read the durable receipt.
const source = readFileSync(new URL('../../app/api/chat/[session_id]/events/route.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(hostFetch, history = []) {
  const persisted = []
  const rpcCalls = []
  const query = {
    update() { return this },
    eq() { return this },
    then(resolve) { return Promise.resolve({ error: null }).then(resolve) },
  }
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) },
    schema() { return this },
    from() { return query },
    rpc: async (name) => { rpcCalls.push(name); return { data: true, error: null } },
  }
  class Adapter {
    constructor(sessionId, clock, sequence) { Object.assign(this, { sessionId, clock, sequence }) }
    adapt(frame) {
      return [{
        version: 1, id: 'event-' + this.sequence, sequence: this.sequence++,
        sessionId: this.sessionId, timestamp: this.clock(), source: 'pi',
        ...(frame.type === 'extension_error'
          ? { type: 'error', errorId: 'failure', message: frame.error }
          : { type: 'session.completed' }),
      }]
    }
  }
  const modules = {
    '@/lib/agent-runtime/prompt-attachments': {
      parsePromptAttachments: (value) => value === undefined ? [] : Array.isArray(value) ? value : null,
    },
    '@/lib/chat-session-uploads.server': { resolvePromptFileAttachments: async (_db, _session, _user, attachments) => attachments },
    '@/lib/agent-runtime/message-revisions': { projectMessageRevisions: (events) => events },
    '@/lib/agent-runtime/pi-event-adapter': { PiEventAdapter: Adapter },
    '@/lib/agent-runtime/codex-event-adapter': { CodexEventAdapter: Adapter },
    '@/lib/agent-runtime/stream-integrity': {
      isTerminalErrorEvent: (event) => event.type === 'error' && event.recoverable !== true,
      missingTerminalEventMessage: () => 'missing terminal',
    },
    'node:crypto': { randomBytes: () => Buffer.from('holder') },
    '@/lib/ai-provider-configurations.server': {
      resolveAgentProviderRuntimeConfiguration: async () => ({ providerId: 'test', modelId: 'test' }),
    },
    '@/lib/chat-session-persistence.server': {
      listPersistedChatEvents: async () => history,
      findFirstPersistedUserMessage: async () => null,
      nextChatEventSequence: async () => 0,
      loadPiSessionSnapshot: async () => undefined,
      parsePiSessionDelta: () => null,
      persistChatEvents: async (_db, _user, _session, events) => { persisted.push(...events) },
      persistPiSessionDelta: async () => {},
    },
    '@/lib/chat-sessions': {
      isChatSessionId: () => true,
      getChatSession: async () => ({
        id: 'session', workspace_id: 'workspace', project_id: 'project',
        agent: 'pi', initial_prompt: 'hello', access_mode: 'restricted',
      }),
    },
    '@/utils/supabase/server': { createClient: async () => db },
  }
  const exports = {}
  new Function('require', 'exports', 'fetch', 'process', compiled)(
    (id) => { assert.ok(id in modules, id); return modules[id] },
    exports,
    hostFetch,
    { env: { OPENLINK_AGENT_HOST_URL: 'http://agent.test', OPENLINK_AGENT_API_TOKEN: 'test' } },
  )
  const send = (signal, body = { message: 'hello', requestKind: 'initial-prompt' }) => exports.POST(new Request('http://app.test/api/chat/session/events', {
    method: 'POST', body: JSON.stringify(body), signal,
  }), { params: Promise.resolve({ session_id: 'session' }) })
  return { send, persisted, rpcCalls }
}

test('edit receipt retains original message id only after native rewind is confirmed', async () => {
  const calls = []
  const original = { type: 'message.user', messageId: 'original', text: 'before' }
  const app = harness(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (url.endsWith('/control')) return Response.json({ result: { rewound: true } })
    return new Response('{"type":"agent_settled"}\n')
  }, [original])
  const response = await app.send(undefined, { message: 'after', editMessageId: 'original' })
  await response.text()
  assert.equal(response.status, 200)
  assert.equal(calls[0].body.action, 'rewind')
  assert.equal(calls[0].body.text, 'before')
  const users = app.persisted.filter((event) => event.type === 'message.user')
  assert.equal(users.length, 1)
  assert.equal(users[0].messageId, 'original')
  assert.equal(users[0].replacesMessageId, 'original')
  assert.equal(users[0].text, 'after')
})

test('failed native rewind never persists a duplicate or sends an ordinary prompt', async () => {
  let calls = 0
  const app = harness(async () => { calls++; return Response.json({ error: 'unsupported' }, { status: 400 }) }, [
    { type: 'message.user', messageId: 'original', text: 'before' },
  ])
  const response = await app.send(undefined, { message: 'after', editMessageId: 'original' })
  assert.equal(response.status, 409)
  assert.equal(app.persisted.length, 0)
  assert.equal(calls, 1)
  assert.equal(app.rpcCalls.at(-1), 'release_chat_session_lease')
})

test('unknown edit target fails before mutating the native runtime', async () => {
  const app = harness(async () => { throw new Error('must not contact host') })
  const response = await app.send(undefined, { message: 'after', editMessageId: 'missing' })
  assert.equal(response.status, 409)
  assert.equal(app.persisted.length, 0)
})

test('durable receipt is readable while cold Host startup remains pending', { timeout: 2000 }, async () => {
  const ready = Promise.withResolvers()
  const h = harness(() => ready.promise)
  let reader
  try {
    const response = await h.send()
    assert.equal(response.status, 200)
    reader = response.body.getReader()
    const first = await reader.read()
    assert.equal(JSON.parse(new TextDecoder().decode(first.value)).type, 'message.user')
    assert.equal(h.persisted[0].text, 'hello')
    assert.equal(h.rpcCalls.includes('release_chat_session_lease'), false)
  } finally {
    ready.resolve(new Response('{"type":"agent_settled"}\n'))
    if (reader) while (!(await reader.read()).done) {}
  }
  assert.deepEqual(h.persisted.map((event) => event.type), ['message.user', 'session.completed'])
  // Stream close can become visible just before finally releases the lease.
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(h.rpcCalls.includes('release_chat_session_lease'))
})

test('Host startup failure is a durable terminal event after receipt, without leaked diagnostics', async () => {
  const h = harness(async () => new Response('private provider diagnostic', { status: 503 }))
  const response = await h.send()
  const events = (await response.text()).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map((event) => event.type), ['message.user', 'error'])
  assert.equal(events[1].recoverable, false)
  assert.equal(JSON.stringify(events).includes('private provider diagnostic'), false)
  assert.deepEqual(h.persisted.map((event) => event.type), ['message.user', 'error'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(h.rpcCalls.includes('release_chat_session_lease'))
})

test('cancel during provisioning aborts Host and preserves the accepted message', { timeout: 2000 }, async () => {
  const abort = new AbortController()
  let hostAborted = false
  const h = harness(async (url, options) => {
    if (url.endsWith('/cancel')) return new Response('{}')
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        hostAborted = true
        reject(new Error('aborted'))
      }, { once: true })
    })
  })
  const response = await h.send(abort.signal)
  const reader = response.body.getReader()
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'message.user')
  abort.abort()
  while (!(await reader.read()).done) {}
  assert.equal(hostAborted, true)
  assert.deepEqual(h.persisted.map((event) => event.type), ['message.user', 'error'])
})

test('safe Host failure code distinguishes a busy session from preparation timeout', async () => {
  const h = harness(async () => Response.json({ error: { code: 'SESSION_BUSY', message: 'private diagnostic' } }, { status: 409 }))
  const events = (await (await h.send()).text()).trim().split('\n').map(JSON.parse)
  assert.match(events[1].message, /SESSION_BUSY/)
  assert.doesNotMatch(events[1].message, /timed out|private diagnostic/)
})

test('initial prompt has no browser readiness gate while background prewarming remains enabled', () => {
  const ui = readFileSync(new URL('../../components/chat-workspace.tsx', import.meta.url), 'utf8')
  const autoStart = ui.slice(ui.indexOf('if (!autoStart ||'), ui.indexOf('const resolveExtensionUi'))
  assert.doesNotMatch(autoStart, /browserState\.status|if \(!browserState\.browserSessionId/)
  assert.doesNotMatch(ui, /intent: 'keepalive'|passive=1/)
  assert.match(ui, /refreshLease\(\)/)
  const warmup = ui.slice(ui.indexOf('// Proactively prepare the Agent'), ui.indexOf('const submitAgentMessage'))
  assert.doesNotMatch(warmup, /model: autoStartModel/, 'background warmup must use current persisted model, not stale initial props')
})
