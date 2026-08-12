import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_PROTOCOL_VERSION, type BrowserActionEnvelope, type BrowserActionResult } from '@openlink/browser-protocol'
import { BrowserSessionManager, type BrowserRuntimeSession } from '../src/session-manager.js'

class FakeRuntime implements BrowserRuntimeSession {
  readonly surface = 'chromium-stream' as const
  closed = false
  async start(): Promise<void> {}
  async perform(envelope: BrowserActionEnvelope): Promise<BrowserActionResult> {
    return { version: BROWSER_PROTOCOL_VERSION, actionId: envelope.actionId, sessionId: envelope.sessionId, ok: true }
  }
  async close(): Promise<void> { this.closed = true }
}

function envelope(sessionId: string, actor: 'human' | 'agent', actionId: string): BrowserActionEnvelope {
  return { version: BROWSER_PROTOCOL_VERSION, sessionId, actor, actionId, action: { type: 'page.open', url: 'https://example.com' } }
}

test('human input preempts an agent lease and blocks subsequent agent input', async () => {
  let now = 10_000
  const runtime = new FakeRuntime()
  const manager = new BrowserSessionManager({ maxSessions: 2, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000, now: () => now })
  const state = await manager.create({ ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', runtimeFactory: () => runtime })
  assert.equal((await manager.perform(envelope(state.id, 'agent', 'a1'))).ok, true)
  assert.equal(manager.get(state.id).controlOwner, 'agent')
  assert.equal((await manager.perform(envelope(state.id, 'human', 'h1'))).ok, true)
  assert.equal(manager.get(state.id).controlOwner, 'human')
  await assert.rejects(() => manager.perform(envelope(state.id, 'agent', 'a2')), /held by human/)
  now += 5_001
  assert.equal((await manager.perform(envelope(state.id, 'agent', 'a3'))).ok, true)
  await manager.close(state.id)
  assert.equal(runtime.closed, true)
})

test('session event replay is monotonic and bounded to the requested cursor', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  const state = await manager.create({ ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', runtimeFactory: () => new FakeRuntime() })
  await manager.perform(envelope(state.id, 'human', 'h1'))
  const all = manager.replay(state.id)
  assert.ok(all.length >= 4)
  for (let index = 1; index < all.length; index++) assert.ok(all[index].sequence > all[index - 1].sequence)
  const cursor = all[Math.floor(all.length / 2)].sequence
  assert.ok(manager.replay(state.id, cursor).every((event) => event.sequence > cursor))
  await manager.closeAll()
})

test('retains the latest screencast for late browser clients', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  const state = await manager.create({ ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', runtimeFactory: (context) => {
    const runtime = new FakeRuntime()
    runtime.start = async () => {
      context.emit({ type: 'page.screencast', pageId: 'page-1', frameId: 1, mimeType: 'image/jpeg', data: 'frame-1', width: 1280, height: 800, deviceScaleFactor: 1 })
      context.emit({ type: 'page.screencast', pageId: 'page-1', frameId: 2, mimeType: 'image/jpeg', data: 'frame-2', width: 1280, height: 800, deviceScaleFactor: 1 })
    }
    return runtime
  } })
  const latest = manager.latestScreencasts(state.id)
  assert.equal(latest.length, 1)
  assert.equal(latest[0]?.event.type, 'page.screencast')
  if (latest[0]?.event.type === 'page.screencast') assert.equal(latest[0].event.data, 'frame-2')
  await manager.closeAll()
})

test('deduplicates concurrent creation for the same persistent Chromium profile', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 2, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  let starts = 0
  let releaseStart!: () => void
  const started = new Promise<void>((resolve) => { releaseStart = resolve })
  const create = () => manager.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', reuseKey: 'stable-profile',
    runtimeFactory: () => {
      const runtime = new FakeRuntime()
      runtime.start = async () => { starts += 1; await started }
      return runtime
    },
  })
  const first = create()
  await new Promise((resolve) => setImmediate(resolve))
  const second = create()
  releaseStart()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left.id, right.id)
  assert.equal(starts, 1)
  await manager.close(left.id)
})

test('emits refreshed expiry when a browser heartbeat touches the session', async () => {
  let now = 10_000
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000, now: () => now })
  const state = await manager.create({ ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', runtimeFactory: () => new FakeRuntime() })
  const before = manager.replay(state.id).length
  now += 30_000
  manager.touch(state.id)
  const refreshed = manager.replay(state.id).at(-1)
  assert.equal(refreshed?.event.type, 'session.state')
  assert.equal(refreshed?.event.type === 'session.state' ? Date.parse(refreshed.event.state.expiresAt) : 0, now + 60_000)
  assert.equal(refreshed?.event.type === 'session.state' ? Date.parse(refreshed.event.state.updatedAt) : 0, now)
  assert.equal(manager.replay(state.id).length, before + 1)
  await manager.closeAll()
})

test('control actions cannot impersonate the other actor', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  const state = await manager.create({ ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', runtimeFactory: () => new FakeRuntime() })
  await assert.rejects(() => manager.perform({
    version: BROWSER_PROTOCOL_VERSION,
    sessionId: state.id,
    actionId: 'impersonate',
    actor: 'agent',
    action: { type: 'control.acquire', owner: 'human' },
  }), /must match/)
  await manager.closeAll()
})

test('failed browser startup releases its session slot immediately', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  let attempts = 0
  await assert.rejects(() => manager.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream',
    runtimeFactory: () => {
      const runtime = new FakeRuntime()
      runtime.start = async () => { attempts += 1; throw new Error('chromium failed') }
      return runtime
    },
  }), /chromium failed/)
  const recovered = await manager.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream',
    runtimeFactory: () => new FakeRuntime(),
  })
  assert.equal(attempts, 1)
  assert.equal(recovered.status, 'ready')
  await manager.closeAll()
})

test('retains a failed startup when runtime cleanup also fails', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  let closeAttempts = 0
  await assert.rejects(() => manager.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream',
    runtimeFactory: () => {
      const runtime = new FakeRuntime()
      runtime.start = async () => { throw new Error('startup failed') }
      runtime.close = async () => {
        closeAttempts += 1
        if (closeAttempts === 1) throw new Error('cleanup failed')
      }
      return runtime
    },
  }), /startup failed/)
  assert.equal(manager.list().length, 1)
  await manager.closeAll()
  assert.equal(closeAttempts, 2)
  assert.equal(manager.list().length, 0)
})

test('reserves max session capacity while concurrent runtimes are starting', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  let releaseStart!: () => void
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
  const first = manager.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream',
    runtimeFactory: () => {
      const runtime = new FakeRuntime()
      runtime.start = () => startGate
      return runtime
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(() => manager.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream', runtimeFactory: () => new FakeRuntime(),
  }), /limit reached/)
  releaseStart()
  const state = await first
  assert.equal(state.status, 'ready')
  await manager.closeAll()
})

test('retains a browser session when runtime close fails so cleanup can be retried', async () => {
  const manager = new BrowserSessionManager({ maxSessions: 1, sessionTtlMs: 60_000, controlLeaseTtlMs: 5_000 })
  let closeAttempts = 0
  const state = await manager.create({
    ownerId: 'user', workspaceId: 'workspace', projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c', surface: 'chromium-stream',
    runtimeFactory: () => {
      const runtime = new FakeRuntime()
      runtime.close = async () => {
        closeAttempts += 1
        if (closeAttempts === 1) throw new Error('close failed')
        runtime.closed = true
      }
      return runtime
    },
  })

  await assert.rejects(() => manager.close(state.id), /close failed/)
  assert.equal(manager.list().length, 1)
  assert.equal(manager.get(state.id).status, 'failed')
  await manager.close(state.id)
  assert.equal(closeAttempts, 2)
  assert.equal(manager.list().length, 0)
})
