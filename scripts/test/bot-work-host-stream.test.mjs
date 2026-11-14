import assert from 'node:assert/strict'
import test from 'node:test'

import { botUpdatesFromWorkHostFrame } from '../../lib/bot-work-host-stream.ts'
import { normalizeWorkHostTranscript, pendingConfirmationsFromTranscript, transcriptFromAgentEvents } from '../../lib/bot-transcript.ts'

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
  assert.equal(updates[0].entry.kind, 'confirmation')
  assert.deepEqual(updates[0].entry.confirmation, {
    id: 'dialog-1',
    title: 'Continue?',
    message: 'Deploy now?',
    inputKind: 'confirm',
    status: 'pending',
  })
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
  assert.deepEqual(pending[0], { type: 'pending', pending: { label: 'read', showLabel: true, state: 'reading' } })
  assert.deepEqual(completed[0], { type: 'pending', pending: { label: '4 files', showLabel: true, state: 'reading' } })
  const pendingEntry = pending.find((update) => update.type === 'entry')
  const completedEntry = completed.find((update) => update.type === 'entry')
  assert.equal(pendingEntry.entry.id, 'bot-tool-call-1')
  assert.equal(pendingEntry.entry.activity.status, 'running')
  assert.equal(completedEntry.entry.id, 'bot-tool-call-1')
  assert.equal(completedEntry.entry.activity.status, 'done')
  assert.equal(completedEntry.entry.activity.detail, '4 files')
})

test('turn and group lifecycles drive the pending state and terminate the stream', () => {
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'bot-turn', payload: { agentId: 'agent-1', phase: 'started' } }), [
    { type: 'pending', pending: { label: 'Working', showLabel: true, state: 'thinking' } },
  ])
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'bot-turn', payload: { agentId: 'agent-1', phase: 'ended', ok: true } }), [
    { type: 'pending', pending: null },
    { type: 'done' },
  ])
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'bot-turn', payload: { agentId: 'agent-1', phase: 'ended', ok: false, error: 'provider unavailable' } }), [
    { type: 'pending', pending: null },
    { type: 'error', message: 'provider unavailable' },
    { type: 'done' },
  ])
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'transcript', payload: { agentId: 'group-1', type: 'group-turn', phase: 'started' } }), [
    { type: 'pending', pending: { label: 'Working', showLabel: true, state: 'thinking' } },
  ])
  assert.deepEqual(botUpdatesFromWorkHostFrame({ channel: 'transcript', payload: { agentId: 'group-1', type: 'group-turn', phase: 'ended', ok: true } }), [
    { type: 'pending', pending: null },
    { type: 'done' },
  ])
})

test('a resolved question and a live status line are projected', () => {
  assert.deepEqual(botUpdatesFromWorkHostFrame({
    channel: 'transcript',
    payload: {
      type: 'appended',
      agentId: 'agent-1',
      entry: { id: 'resolved-1', kind: 'event', timestampMs: 3, event: { type: 'confirmation-resolved', extensionUiId: 'dialog-1' } },
    },
  }), [{ type: 'confirmation-resolved', id: 'dialog-1' }])
  assert.deepEqual(botUpdatesFromWorkHostFrame({
    channel: 'bot-turn',
    payload: { agentId: 'agent-1', phase: 'status', label: 'Checking the deploy' },
  }), [{ type: 'pending', pending: { label: 'Checking the deploy', showLabel: true, state: 'working' } }])
})

test('legacy migration bookkeeping is not a timeline entry', () => {
  assert.deepEqual(normalizeWorkHostTranscript([
    { id: 'legacy-migration-complete', kind: 'event', event: { type: 'legacy-migration-complete' }, timestampMs: 1 },
  ]), [])
})

test('a resolved question is answered on reload', () => {
  const transcript = normalizeWorkHostTranscript([
    {
      id: 't1s0',
      kind: 'send-message',
      timestampMs: 1,
      message: { type: 'widget', widget: { kind: 'bot-question', id: 'q1', title: 'Continue?' } },
    },
    { id: 'resolved-1', kind: 'event', event: { type: 'confirmation-resolved', extensionUiId: 'q1' }, timestampMs: 2 },
  ])
  assert.equal(transcript[0].kind, 'confirmation')
  assert.equal(transcript[0].confirmation.status, 'answered')
})

test('pending questions are derived from the normalized timeline', () => {
  const pending = normalizeWorkHostTranscript([{
    id: 't1s0',
    kind: 'send-message',
    timestampMs: 1,
    message: { type: 'widget', widget: { kind: 'bot-question', id: 'q1', title: 'Pick', method: 'select', options: ['a', 'b'] } },
  }])
  assert.deepEqual(pendingConfirmationsFromTranscript(pending), [{
    id: 'q1',
    title: 'Pick',
    options: ['a', 'b'],
    inputKind: 'select',
    confirmationKind: 'question',
  }])
  const answered = normalizeWorkHostTranscript([
    {
      id: 't1s0',
      kind: 'send-message',
      timestampMs: 1,
      message: { type: 'widget', widget: { kind: 'bot-question', id: 'q1', title: 'Pick' } },
    },
    { id: 'resolved-1', kind: 'event', event: { type: 'confirmation-resolved', extensionUiId: 'q1' }, timestampMs: 2 },
  ])
  assert.deepEqual(pendingConfirmationsFromTranscript(answered), [])
})

test('legacy confirmation events migrate as durable question cards', () => {
  const requested = {
    type: 'confirmation.requested',
    id: 'event-1',
    timestamp: '2026-01-01T00:00:00Z',
    confirmationId: 'legacy-question',
    title: 'Continue?',
    message: 'Deploy now?',
    inputKind: 'confirm',
    confirmationKind: 'approval',
  }
  const pending = transcriptFromAgentEvents([requested])
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'confirmation')
  assert.equal(pending[0].confirmation.status, 'pending')
  assert.deepEqual(pendingConfirmationsFromTranscript(pending).map((request) => request.id), ['legacy-question'])

  const answered = transcriptFromAgentEvents([
    requested,
    {
      type: 'confirmation.resolved',
      id: 'event-2',
      timestamp: '2026-01-01T00:00:01Z',
      confirmationId: 'legacy-question',
      approved: true,
    },
  ])
  assert.equal(answered[0].kind, 'confirmation')
  assert.equal(answered[0].confirmation.status, 'answered')
  assert.deepEqual(pendingConfirmationsFromTranscript(answered), [])
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
