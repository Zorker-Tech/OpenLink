import assert from 'node:assert/strict'
import test from 'node:test'

import { isTerminalErrorEvent, missingTerminalEventMessage, orderAgentEvents, recoverInterruptedInitialEvents } from '../../lib/agent-runtime/stream-integrity.ts'

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

test('replayed frames after a reconnect are restored to durable sequence order', () => {
  const base = (sequence, type, payload) => ({
    version: 1,
    id: `event-${sequence}-${type}`,
    sequence,
    sessionId: 'session-1',
    timestamp: new Date(Date.UTC(2026, 8, 16, 0, 0, sequence)).toISOString(),
    source: 'demo',
    type,
    ...payload,
  })
  const inOrder = [
    base(0, 'message.user', { messageId: 'user-1', text: 'hello' }),
    base(1, 'command.started', { commandId: 'c1', command: 'ls' }),
    base(2, 'command.completed', { commandId: 'c1', output: 'ok', exitCode: 0 }),
  ]
  // Already ordered arrays are returned untouched so memoized timelines bail out.
  assert.equal(orderAgentEvents(inOrder), inOrder)

  // A reconnect replays frames that were already superseded by later live
  // frames. Reducing in arrival order moved every following task into the wrong
  // round; ordering by sequence keeps the round structure deterministic.
  const jittered = [
    inOrder[0],
    base(3, 'status.updated', { statusId: 'reconnect', label: 'Reconnecting…', status: 'active' }),
    inOrder[1],
    inOrder[2],
  ]
  const ordered = orderAgentEvents(jittered)
  assert.deepEqual(ordered.map((event) => event.sequence), [0, 1, 2, 3])
  assert.equal(ordered[0], jittered[0], 'stable entries keep their identity')
})

test('events sharing a sequence fall back to a stable timestamp and id order', () => {
  const make = (id, sequence, timestamp) => ({
    version: 1,
    id,
    sequence,
    sessionId: 'session-1',
    timestamp,
    source: 'demo',
    type: 'status.updated',
    statusId: id,
    label: id,
    status: 'active',
  })
  // The decreasing pair triggers the sort; equal sequences then resolve by
  // timestamp, and identical timestamps by id, so rendering cannot depend on
  // the order the transport happened to deliver.
  const ordered = orderAgentEvents([
    make('c', 7, '2026-09-16T00:00:02.000Z'),
    make('b', 7, '2026-09-16T00:00:01.000Z'),
    make('a', 7, '2026-09-16T00:00:01.000Z'),
    make('x', 3, '2026-09-16T00:00:00.000Z'),
  ])
  assert.deepEqual(ordered.map((event) => event.id), ['x', 'a', 'b', 'c'])
})
