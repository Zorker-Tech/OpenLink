import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OPTIMISTIC_USER_ENTRY_PREFIX,
  optimisticUserEntry,
  reconcileOptimisticUserEntry,
} from '../../lib/bot-transcript.ts'

function user(id, timestampMs, content = id) {
  return { kind: 'user-message', id, content, timestampMs }
}

function agent(id, timestampMs, content = id) {
  return { kind: 'agent-message', id, content, timestampMs }
}

test('the durable user echo replaces the optimistic bubble in place', () => {
  const optimistic = optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}nonce`, 'hi')
  const durable = user('user-message-1', 2, 'hi')
  const result = reconcileOptimisticUserEntry([agent('agent-1', 1), optimistic], durable)
  assert.deepEqual(result.map((entry) => entry.id), ['agent-1', 'user-message-1'])
  assert.equal(result[1], durable)
})

test('an echo that arrives before the optimistic copy does not duplicate it', () => {
  const durable = user('user-message-1', 2, 'hi')
  const optimistic = optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}nonce`, 'hi')
  const first = reconcileOptimisticUserEntry([durable], durable)
  assert.deepEqual(first, [durable])
  const second = reconcileOptimisticUserEntry([...first, optimistic], durable)
  assert.deepEqual(second.map((entry) => entry.id), ['user-message-1'])
})

test('a durable echo with different content is appended', () => {
  const optimistic = optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}nonce`, 'first')
  const durable = user('user-message-1', 2, 'second')
  const result = reconcileOptimisticUserEntry([optimistic], durable)
  assert.deepEqual(result.map((entry) => entry.id), [`${OPTIMISTIC_USER_ENTRY_PREFIX}nonce`, 'user-message-1'])
})

test('non-user entries still upsert by id', () => {
  const first = agent('agent-1', 1, 'a')
  const updated = agent('agent-1', 2, 'b')
  const result = reconcileOptimisticUserEntry([first], updated)
  assert.deepEqual(result, [updated])
})
