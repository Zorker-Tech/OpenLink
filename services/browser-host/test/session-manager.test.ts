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
