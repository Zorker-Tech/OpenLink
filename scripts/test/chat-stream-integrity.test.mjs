import assert from 'node:assert/strict'
import test from 'node:test'

import { isTerminalErrorEvent, missingTerminalEventMessage, recoverInterruptedInitialEvents } from '../../lib/agent-runtime/stream-integrity.ts'

test('a worker stream without a terminal event produces a durable failure', () => {
  assert.equal(
    missingTerminalEventMessage(false),
    'Agent worker ended before reporting a terminal state',
  )
})

test('a disconnected worker stream records cancellation instead of disappearing', () => {
  assert.equal(
    missingTerminalEventMessage(true),
    'Agent request was canceled before the worker reported a terminal state',
  )
})

test('recoverable reconnect notices do not count as a terminal stream state', () => {
  assert.equal(isTerminalErrorEvent({ type: 'error', recoverable: true }), false)
  assert.equal(isTerminalErrorEvent({ type: 'error', recoverable: false }), true)
  assert.equal(isTerminalErrorEvent({ type: 'error' }), true)
})

const event = (sequence, type, extra = {}) => ({
  version: 1,
  id: `session-1:${sequence}`,
  sequence,
  sessionId: 'session-1',
  timestamp: '2026-09-05T01:00:00.000Z',
  source: 'codex',
  type,
  ...extra,
})

test('a reloaded durable history cannot rebuild an eternal in-progress turn', () => {
  const recovered = recoverInterruptedInitialEvents([
    event(0, 'message.user', { messageId: 'user-1', text: 'hello' }),
    event(1, 'session.started'),
    event(2, 'reasoning.delta', { reasoningId: 'reasoning-1', delta: 'thinking' }),
  ], new Date('2026-09-05T01:01:00.000Z'))

  assert.equal(recovered.length, 4)
  assert.deepEqual(recovered.at(-1), {
    ...event(3, 'error'),
    id: 'session-1:disconnected-turn:3',
    timestamp: '2026-09-05T01:01:00.000Z',
    errorId: 'session-1:disconnected-turn:3',
    message: 'Previous agent stream disconnected before reporting a terminal state',
    recoverable: false,
  })
})

test('completed and terminal-error histories are not rewritten on reload', () => {
  const completed = [
    event(0, 'message.user', { messageId: 'user-1', text: 'hello' }),
    event(1, 'session.started'),
    event(2, 'session.completed'),
  ]
  const failed = [
    event(0, 'message.user', { messageId: 'user-1', text: 'hello' }),
    event(1, 'session.started'),
    event(2, 'error', { errorId: 'failure', message: 'failed', recoverable: false }),
  ]
  assert.equal(recoverInterruptedInitialEvents(completed), completed)
  assert.equal(recoverInterruptedInitialEvents(failed), failed)
})
