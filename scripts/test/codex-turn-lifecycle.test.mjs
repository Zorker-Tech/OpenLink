import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexTurnLifecycle } from '../../services/agent-worker/src/codex-turn-lifecycle.ts'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('retryable and non-retryable error notifications wait for native turn completion', async () => {
  const controller = new AbortController()
  const lifecycle = new CodexTurnLifecycle(controller.signal, 'thread-1', 1_000, () => {})
  let settled = false
  void lifecycle.promise.then(() => { settled = true })

  lifecycle.onNotification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
  lifecycle.onNotification('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { message: 'retry' } })
  lifecycle.onNotification('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { message: 'failed' } })
  await tick()
  assert.equal(settled, false)

  lifecycle.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } })
  await lifecycle.promise
  assert.equal(settled, true)
})

test('notifications from another thread or turn cannot settle the active turn', async () => {
  const controller = new AbortController()
  const lifecycle = new CodexTurnLifecycle(controller.signal, 'thread-1', 1_000, () => {})
  let settled = false
  void lifecycle.promise.then(() => { settled = true })
  lifecycle.bindTurn('turn-1')

  lifecycle.onNotification('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-1' } })
  lifecycle.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2' } })
  await tick()
  assert.equal(settled, false)

  lifecycle.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } })
  await lifecycle.promise
})

test('app-server exit rejects the active lifecycle instead of leaving busy forever', async () => {
  const lifecycle = new CodexTurnLifecycle(new AbortController().signal, 'thread-1', 1_000, () => {})
  await assert.rejects(
    async () => {
      lifecycle.fail(new Error('Codex app-server exited (1)'))
      await lifecycle.promise
    },
    /app-server exited/,
  )
})

test('an idle native turn is interrupted and rejected', async () => {
  let interrupted = false
  const lifecycle = new CodexTurnLifecycle(new AbortController().signal, 'thread-1', 20, () => { interrupted = true })
  await assert.rejects(lifecycle.promise, /stopped emitting events/)
  assert.equal(interrupted, true)
})

test('browser cancellation settles the lifecycle without a rejection', async () => {
  const controller = new AbortController()
  const lifecycle = new CodexTurnLifecycle(controller.signal, 'thread-1', 1_000, () => {})
  controller.abort()
  await lifecycle.promise
})
