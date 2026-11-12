import assert from 'node:assert/strict'
import test from 'node:test'

import { botUpdatesFromWorkHostFrame } from '../../lib/bot-work-host-stream.ts'

test('a Work-host user message becomes a Bot timeline entry', () => {
  const updates = botUpdatesFromWorkHostFrame({
    channel: 'transcript',
    payload: {
      type: 'appended',
      agentId: 'agent-1',
      entry: { id: 't0u', kind: 'message', role: 'user', content: 'hello', timestampMs: 1 },
    },
  })
  assert.deepEqual(updates, [{
    type: 'entry',
    entry: { kind: 'user-message', id: 't0u', content: 'hello', timestampMs: 1 },
  }])
})

test('a Pi question widget is both a timeline entry and an actionable confirmation', () => {
  const updates = botUpdatesFromWorkHostFrame({
    channel: 'transcript',
    payload: {
      type: 'appended',
      agentId: 'agent-1',
      entry: {
        id: 't1s0',
        kind: 'send-message',
        timestampMs: 2,
        message: {
          type: 'widget',
          widget: { kind: 'bot-question', id: 'dialog-1', method: 'confirm', title: 'Continue?', prompt: 'Deploy now?' },
        },
      },
    },
  })
  assert.equal(updates.length, 2)
  assert.equal(updates[0].type, 'entry')
  assert.equal(updates[0].entry.kind, 'activity')
  assert.deepEqual(updates[1], {
    type: 'confirmation',
    request: {
      id: 'dialog-1',
      title: 'Continue?',
      message: 'Deploy now?',
      inputKind: 'confirm',
      confirmationKind: 'approval',
    },
  })
})

test('outline tool calls become live activity rows with a stable id', () => {
  const pending = botUpdatesFromWorkHostFrame({
    channel: 'outline',
    payload: { type: 'appended', agentId: 'agent-1', item: { kind: 'tool-call', id: 'call-1', name: 'read', status: 'pending' } },
  })
  const completed = botUpdatesFromWorkHostFrame({
    channel: 'outline',
    payload: { type: 'updated', agentId: 'agent-1', item: { kind: 'tool-call', id: 'call-1', name: 'read', status: 'completed', summary: '4 files' } },
  })
  assert.equal(pending[0].entry.id, 'bot-tool-call-1')
  assert.equal(pending[0].entry.activity.status, 'running')
  assert.equal(completed[0].entry.id, 'bot-tool-call-1')
  assert.equal(completed[0].entry.activity.status, 'done')
  assert.equal(completed[0].entry.activity.detail, '4 files')
})

test('turn and group lifecycles drive the pending state and terminate the stream', () => {
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'bot-turn', payload: { agentId: 'agent-1', phase: 'started' } }), [
    { type: 'pending', pending: { label: 'Working', showLabel: true } },
  ])
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'bot-turn', payload: { agentId: 'agent-1', phase: 'ended', ok: true } }), [
    { type: 'pending', pending: null },
    { type: 'done' },
  ])
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'transcript', payload: { agentId: 'group-1', type: 'group-turn', phase: 'started' } }), [
    { type: 'pending', pending: { label: 'Working', showLabel: true } },
  ])
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'transcript', payload: { agentId: 'group-1', type: 'group-turn', phase: 'ended', ok: true } }), [
    { type: 'pending', pending: null },
    { type: 'done' },
  ])
})

test('a tray error is surfaced and closes the projection', () => {
  const updates = botUpdatesFromWorkHostFrame({
    channel: 'tray',
    payload: { type: 'pushed', tray: { kind: 'error', agentId: 'agent-1', title: 'Turn failed', detail: 'provider unavailable' } },
  })
  assert.deepEqual(updates, [
    { type: 'error', message: 'provider unavailable' },
    { type: 'done' },
  ])
})
