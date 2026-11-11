import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'

const routeSource = readFileSync(new URL('../../app/api/chat/[session_id]/events/route.ts', import.meta.url), 'utf8')
const routeCode = transformSync(routeSource, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
const engineSource = readFileSync(new URL('../../lib/chat-session-events.server.ts', import.meta.url), 'utf8')
const engineCode = transformSync(engineSource, { loader: 'ts', format: 'cjs', target: 'es2022' }).code

function routeHarness({ session }) {
  let handled = 0
  const modules = {
    '@/lib/chat-session-events.server': {
      handleChatSessionEvents: async (_request, input) => {
        handled++
        return Response.json({ ok: true, sessionId: input.sessionId, surface: input.session.surface })
      },
    },
    '@/lib/chat-sessions': {
      isChatSessionId: () => true,
      getCodeChatSession: async () => session,
    },
    '@/utils/supabase/server': {
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) } }),
    },
  }
  const commonjsModule = { exports: {} }
  new Function('require', 'module', 'exports', routeCode)((id) => modules[id], commonjsModule, commonjsModule.exports)
  return {
    handled: () => handled,
    send: () => commonjsModule.exports.POST(new Request('http://app.test/api/chat/session/events', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello', requestKind: 'initial-prompt' }),
    }), { params: Promise.resolve({ session_id: 'session' }) }),
  }
}

// Execute the shared turn engine with deterministic DB/Host boundaries. In
// particular the Host promise stays unresolved until after we read the
// durable receipt, proving receipt does not depend on runtime provisioning.
function engineHarness(hostFetch, history = [], options = {}) {
  const persisted = []
  const rpcCalls = []
  const runUpdates = []
  const query = {
    update() { return this },
    eq() { return this },
    then(resolve) { return Promise.resolve({ error: null }).then(resolve) },
  }
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) },
    schema() { return this },
    from() { return query },
    rpc: async (name) => {
      rpcCalls.push(name)
      return name === 'acquire_chat_session_lease' ? { data: options.leaseAcquired ?? true, error: null } : { data: true, error: null }
    },
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
    '@/lib/i18n/server': { getT: async () => ({ t: (value) => value }) },
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
    'node:crypto': {
      randomBytes: () => Buffer.from('holder'),
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    },
    '@/lib/ai-provider-configurations.server': {
      resolveAgentProviderRuntimeConfiguration: async () => ({ providerId: 'test', modelId: 'test' }),
    },
    '@/lib/chat-session-persistence.server': {
      getInitialPromptRecoveryState: async () => options.recovery ?? { userMessage: null, retryable: false },
      listPersistedChatEvents: async () => history,
      findFirstPersistedUserMessage: async () => null,
      nextChatEventSequence: async () => 0,
      loadPiSessionSnapshot: async () => undefined,
      parsePiSessionDelta: () => null,
      persistChatEvents: async (_db, _user, _session, events) => { persisted.push(...events) },
      persistPiSessionDelta: async () => {},
    },
    '@/lib/chat-sessions': { isChatSessionId: () => true },
    '@/lib/chat-session-runs.server': {
      startChatSessionRun: async (_db, input) => { runUpdates.push(['start', input.runId]) },
      heartbeatChatSessionRun: async () => {},
      finishChatSessionRun: async (_db, input) => { runUpdates.push(['finish', input.status, input.errorCode ?? null]) },
      getChatSessionRun: async () => null,
    },
    '@/lib/platform-cloud-host.server': { cloudComputerSdkRequest: async () => { throw new Error('unexpected cloud call') } },
    '@/lib/runtime-mode.server': { getRuntimeMode: () => 'local' },
    '@/utils/supabase/server': { createClient: async () => db },
  }
  const commonjsModule = { exports: {} }
  new Function('require', 'module', 'exports', 'fetch', 'process', engineCode)(
    (id) => { assert.ok(id in modules, id); return modules[id] },
    commonjsModule,
    commonjsModule.exports,
    hostFetch,
    { env: { OPENLINK_AGENT_HOST_URL: 'http://agent.test', OPENLINK_AGENT_API_TOKEN: 'test' } },
  )
  const send = (signal, body = { message: 'hello', requestKind: 'initial-prompt' }) => commonjsModule.exports.handleChatSessionEvents(
    new Request('http://app.test/api/chat/session/events', {
      method: 'POST', body: JSON.stringify(body), signal,
    }),
    {
      sessionId: 'session',
      userId: 'user',
      session: {
        id: 'session', user_id: 'user', workspace_id: 'workspace', project_id: 'project',
        agent: 'pi', initial_prompt: 'hello', access_mode: 'restricted', surface: 'code',
      },
    },
  )
  return { send, persisted, rpcCalls, runUpdates }
}

test('Code events route rejects a hidden Bot session before invoking the engine', async () => {
  const h = routeHarness({ session: null })
  const response = await h.send()
  assert.equal(response.status, 404)
  assert.equal(h.handled(), 0)
})

test('Code events route forwards the already-authorized Code session', async () => {
  const h = routeHarness({ session: { id: 'session', user_id: 'user', surface: 'code' } })
  const response = await h.send()
  assert.equal(response.status, 200)
  assert.equal(h.handled(), 1)
  assert.deepEqual(await response.json(), { ok: true, sessionId: 'session', surface: 'code' })
})

test('edit receipt retains original message id only after native rewind is confirmed', async () => {
  const calls = []
  const original = { type: 'message.user', messageId: 'original', text: 'before' }
  const app = engineHarness(async (url, init) => {
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
  const app = engineHarness(async () => { calls++; return Response.json({ error: 'unsupported' }, { status: 400 }) }, [
    { type: 'message.user', messageId: 'original', text: 'before' },
  ])
  const response = await app.send(undefined, { message: 'after', editMessageId: 'original' })
  assert.equal(response.status, 409)
  assert.equal(app.persisted.length, 0)
  assert.equal(calls, 1)
  assert.equal(app.rpcCalls.at(-1), 'release_chat_session_lease')
})

test('unknown edit target fails before mutating the native runtime', async () => {
  const app = engineHarness(async () => { throw new Error('must not contact host') })
  const response = await app.send(undefined, { message: 'after', editMessageId: 'missing' })
  assert.equal(response.status, 409)
  assert.equal(app.persisted.length, 0)
})

test('durable receipt is readable while cold Host startup remains pending', { timeout: 2000 }, async () => {
  const ready = Promise.withResolvers()
  const app = engineHarness(() => ready.promise)
  let reader
  try {
    const response = await app.send()
    assert.equal(response.status, 200)
    reader = response.body.getReader()
    const first = await reader.read()
    assert.equal(JSON.parse(new TextDecoder().decode(first.value)).type, 'message.user')
    assert.equal(app.persisted[0].text, 'hello')
    assert.equal(app.rpcCalls.includes('release_chat_session_lease'), false)
  } finally {
    ready.resolve(new Response('{"type":"agent_settled"}\n'))
    if (reader) while (!(await reader.read()).done) {}
  }
  assert.deepEqual(app.persisted.map((event) => event.type), ['message.user', 'session.completed'])
  assert.deepEqual(app.runUpdates.at(-1), ['finish', 'completed', null])
  // Stream close can become visible just before finally releases the lease.
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(app.rpcCalls.includes('release_chat_session_lease'))
})

test('Host startup failure is a durable terminal event after receipt, without leaked diagnostics', async () => {
  const app = engineHarness(async () => new Response('private provider diagnostic', { status: 503 }))
  const response = await app.send()
  const events = (await response.text()).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map((event) => event.type), ['message.user', 'error'])
  assert.equal(events[1].recoverable, false)
  assert.equal(JSON.stringify(events).includes('private provider diagnostic'), false)
  assert.deepEqual(app.persisted.map((event) => event.type), ['message.user', 'error'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(app.rpcCalls.includes('release_chat_session_lease'))
})

test('a detached browser does not cancel the durable Host turn', { timeout: 2000 }, async () => {
  const abort = new AbortController()
  const ready = Promise.withResolvers()
  let hostAborted = false
  const app = engineHarness(async (_url, options) => {
    options.signal.addEventListener('abort', () => { hostAborted = true }, { once: true })
    return ready.promise
  })
  const response = await app.send(abort.signal)
  const reader = response.body.getReader()
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'message.user')
  abort.abort()
  ready.resolve(new Response('{"type":"agent_settled"}\n'))
  while (!(await reader.read()).done) {}
  assert.equal(hostAborted, false)
  assert.deepEqual(app.persisted.map((event) => event.type), ['message.user', 'session.completed'])
  assert.deepEqual(app.runUpdates.at(-1), ['finish', 'completed', null])
})

test('safe Host failure code distinguishes a busy session from preparation timeout', async () => {
  const app = engineHarness(async () => Response.json({ error: { code: 'SESSION_BUSY', message: 'private diagnostic' } }, { status: 409 }))
  const events = (await (await app.send()).text()).trim().split('\n').map(JSON.parse)
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
