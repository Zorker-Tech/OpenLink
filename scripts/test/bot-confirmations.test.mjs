import assert from 'node:assert/strict'
import test from 'node:test'

import { pendingBotConfirmations, pendingBotConfirmationsFromWorkHostEntries } from '../../lib/bot-confirmations.ts'
import { BotEventAccumulator } from '../../lib/bot-transcript.ts'

function confirmation(id, overrides = {}) {
  return {
    version: 1,
    id: `event-${id}`,
    sequence: 1,
    sessionId: 'BOTSESSION1',
    timestamp: '2026-01-01T00:00:00Z',
    source: 'pi',
    type: 'confirmation.requested',
    confirmationId: id,
    title: 'Run command',
    message: 'rm -rf node_modules',
    inputKind: 'confirm',
    confirmationKind: 'approval',
    ...overrides,
  }
}

function resolved(id) {
  return {
    version: 1,
    id: `event-resolved-${id}`,
    sequence: 2,
    sessionId: 'BOTSESSION1',
    timestamp: '2026-01-01T00:00:01Z',
    source: 'pi',
    type: 'confirmation.resolved',
    confirmationId: id,
    approved: true,
  }
}

test('unresolved Bot approvals survive replay while resolved requests do not', () => {
  const pending = pendingBotConfirmations([
    confirmation('exec:1'),
    confirmation('exec:2'),
    resolved('exec:1'),
  ])
  assert.deepEqual(pending.map((request) => request.id), ['exec:2'])
  assert.equal(pending[0].confirmationKind, 'approval')
  assert.equal(pending[0].inputKind, 'confirm')
})

test('malformed confirmation ids are not rendered or resolved', () => {
  const pending = pendingBotConfirmations([confirmation('../escape')])
  assert.deepEqual(pending, [])
})

test('Work-host question widgets stay pending until a resolution event', () => {
  const question = {
    id: 't1s0',
    kind: 'send-message',
    timestampMs: 1,
    message: {
      type: 'widget',
      widget: { kind: 'bot-question', id: 'dialog-1', method: 'select', title: 'Pick one', prompt: 'Which target?', options: ['staging', 'prod'] },
    },
  }
  assert.deepEqual(pendingBotConfirmationsFromWorkHostEntries([question]), [{
    id: 'dialog-1',
    title: 'Pick one',
    message: 'Which target?',
    options: ['staging', 'prod'],
    inputKind: 'select',
    confirmationKind: 'question',
  }])
  assert.deepEqual(pendingBotConfirmationsFromWorkHostEntries([
    question,
    { id: 'resolved-1', kind: 'event', event: { type: 'confirmation-resolved', extensionUiId: 'dialog-1' }, timestampMs: 2 },
  ]), [])
})

test('the Bot stream surfaces confirmation boundaries without waiting for a reload', () => {
  const accumulator = new BotEventAccumulator()
  const requested = accumulator.consume(confirmation('exec:3'))
  assert.ok(requested.updates.some((update) => update.type === 'confirmation' && update.request.id === 'exec:3'))

  const resolvedUpdate = accumulator.consume(resolved('exec:3'))
  assert.ok(resolvedUpdate.updates.some((update) => update.type === 'confirmation-resolved' && update.id === 'exec:3'))
})
