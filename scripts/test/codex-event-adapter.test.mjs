import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexEventAdapter } from '../../lib/agent-runtime/codex-event-adapter.ts'

const adapter = () => new CodexEventAdapter('TESTSESS01', () => '2026-01-01T00:00:00Z', 100)
const kinds = (events) => events.map((event) => event.type)

test('native usage keeps current context separate from cumulative usage', () => {
  const events = adapter().adapt({ method: 'thread/tokenUsage/updated', params: { tokenUsage: {
    total: { totalTokens: 90000, inputTokens: 80000, outputTokens: 10000, cachedInputTokens: 40000, reasoningOutputTokens: 2000 },
    last: { totalTokens: 12000 }, modelContextWindow: 128000,
  } } })
  assert.equal(events[0].type, 'usage.updated')
  assert.equal(events[0].totalTokens, 90000)
  assert.equal(events[0].contextTokens, 12000)
  assert.equal(events[0].contextWindow, 128000)
  assert.deepEqual(adapter().adapt({ method: 'thread/tokenUsage/updated', params: {} }), [])
})

test('native user-input completion is persisted so reopened approval docks stay resolved', () => {
  const events = adapter().adapt({ type: 'openlink_confirmation_resolved', id: 'input:7:0', confirmed: true, value: 'A' })
  assert.equal(events[0].type, 'confirmation.resolved')
  assert.equal(events[0].approved, true)
  assert.equal(events[0].value, 'A')
})

test('thread/started maps to session.started with codex source and envelope', () => {
  const events = adapter().adapt({ method: 'thread/started', params: { threadId: 't1' } })
  assert.deepEqual(kinds(events), ['session.started'])
  assert.equal(events[0].source, 'codex')
  assert.equal(events[0].sessionId, 'TESTSESS01')
  assert.equal(events[0].sequence, 100)
  assert.equal(events[0].timestamp, '2026-01-01T00:00:00Z')
})

test('a full turn streams deltas, completes messages, commands and status', () => {
  const a = adapter()
  const all = [
    ...a.adapt({ method: 'turn/started', params: { turnId: 'u1', threadId: 't1' } }),
    ...a.adapt({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Hello' } }),
    ...a.adapt({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: ' world' } }),
    ...a.adapt({ method: 'item/completed', params: { item: { type: 'agent_message', id: 'm1', text: 'Hello world' } } }),
    ...a.adapt({ method: 'item/started', params: { item: { type: 'command_execution', id: 'c1', command: 'ls' } } }),
    ...a.adapt({ method: 'item/completed', params: { item: { type: 'command_execution', id: 'c1', command: 'ls', aggregatedOutput: 'total 0', exitCode: 0, status: 'completed' } } }),
    ...a.adapt({ method: 'turn/completed', params: { turnId: 'u1' } }),
  ]
  assert.deepEqual(kinds(all), [
    'session.started',
    'message.delta',
    'message.delta',
    'message.completed',
    'command.started',
    'command.completed',
    'session.completed',
  ])
  assert.equal(all[1].delta, 'Hello')
  assert.equal(all[2].delta, ' world')
  assert.equal(all[3].text, 'Hello world')
  assert.equal(all[4].command, 'ls')
  assert.equal(all[5].exitCode, 0)
  assert.equal(all[6].type, 'session.completed')
})

test('current app-server camelCase items map to canonical events', () => {
  const a = adapter()
  const all = [
    ...a.adapt({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'Hello from Codex' } } }),
    ...a.adapt({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'pwd' } } }),
    ...a.adapt({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', aggregatedOutput: '/workspace', exitCode: 0 } } }),
    ...a.adapt({ method: 'item/started', params: { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'src/a.ts', kind: 'update' }] } } }),
    ...a.adapt({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'f1', status: 'completed' } } }),
  ]
  assert.deepEqual(kinds(all), ['message.completed', 'command.started', 'command.completed', 'file.editing.started', 'file.editing.completed'])
  assert.equal(all[0].text, 'Hello from Codex')
})

test('reasoning deltas map to reasoning events', () => {
  const a = adapter()
  const all = [
    ...a.adapt({ method: 'item/started', params: { item: { type: 'reasoning', id: 'r1' } } }),
    ...a.adapt({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'hmm' } }),
    ...a.adapt({ method: 'item/completed', params: { item: { type: 'reasoning', id: 'r1', text: 'hmm' } } }),
  ]
  assert.deepEqual(kinds(all), ['reasoning.started', 'reasoning.delta', 'reasoning.completed'])
  assert.equal(all[1].reasoningId, 'r1')
  assert.equal(all[2].text, 'hmm')
})

test('current reasoning arrays are preserved on completion', () => {
  const events = adapter().adapt({
    method: 'item/completed',
    params: { item: { type: 'reasoning', id: 'r1', summary: ['first'], content: ['second'] } },
  })
  assert.equal(events[0].text, 'first\nsecond')
})

test('approval requests surface as confirmation.requested', () => {
  const events = adapter().adapt({
    method: 'execCommandApproval',
    params: { conversationId: 't1', callId: 'c9', command: ['rm', '-rf', 'node_modules'] },
  })
  assert.deepEqual(kinds(events), ['confirmation.requested'])
  assert.match(events[0].message, /rm -rf node_modules/)
})

test('worker approval passthrough surfaces as confirmation.requested', () => {
  const events = adapter().adapt({
    type: 'extension_ui_request', id: 'exec:42', requestKind: 'approval', method: 'confirm', title: '执行确认', message: '是否执行 pwd',
  })
  assert.deepEqual(kinds(events), ['confirmation.requested'])
  assert.equal(events[0].confirmationId, 'exec:42')
  assert.equal(events[0].confirmationKind, 'approval')
})

test('worker questions remain distinct from approvals', () => {
  const events = adapter().adapt({
    type: 'extension_ui_request', id: 'input:7:0', requestKind: 'question', method: 'select', title: '方向', options: ['A', 'B'],
  })
  assert.equal(events[0].confirmationKind, 'question')
  assert.equal(events[0].inputKind, 'select')
})

test('failed current turns emit an error and still terminate the session', () => {
  const events = adapter().adapt({
    method: 'turn/completed',
    params: { turn: { id: 't1', status: 'failed', error: { message: 'provider rejected request' } } },
  })
  assert.deepEqual(kinds(events), ['error', 'session.completed'])
  assert.equal(events[0].message, 'provider rejected request')
})

test('worker passthrough frames map: git snapshot, file preview, extension error', () => {
  const a = adapter()
  const git = a.adapt({ type: 'openlink_git_snapshot', toolCallId: 'c1', baseCommit: 'abc123', files: [{ path: 'a.ts', additions: 2 }], additions: 2, deletions: 0, signature: 's1' })
  assert.deepEqual(kinds(git), ['file.changed'])
  assert.equal(git[0].snapshot, true)
  assert.equal(git[0].baseCommit, 'abc123')

  const preview = a.adapt({ type: 'openlink_file_preview', editId: 'e1', path: 'src/a.ts', operation: 'edit', language: 'typescript', content: 'let x' })
  assert.deepEqual(kinds(preview), ['file.editing.started'])
  assert.equal(preview[0].path, 'src/a.ts')

  const failure = a.adapt({ type: 'extension_error', error: 'codex crashed' })
  assert.deepEqual(kinds(failure), ['error'])
  assert.equal(failure[0].message, 'codex crashed')
  assert.equal(failure[0].recoverable, true)

  const terminalFailure = a.adapt({ type: 'extension_error', error: 'codex exited', terminal: true })
  assert.deepEqual(kinds(terminalFailure), ['error'])
  assert.equal(terminalFailure[0].recoverable, false)
})

test('unrecognized notifications and malformed frames produce no events', () => {
  const a = adapter()
  assert.deepEqual(a.adapt({ method: 'item/updated', params: {} }), [])
  assert.deepEqual(a.adapt('not-an-object'), [])
  assert.deepEqual(a.adapt(null), [])
  assert.deepEqual(a.adapt({ params: {} }), [])
})

test('sequences advance monotonically across frames', () => {
  const a = adapter()
  const events = [
    ...a.adapt({ method: 'turn/started', params: {} }),
    ...a.adapt({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'x' } }),
    ...a.adapt({ method: 'turn/completed', params: {} }),
  ]
  const sequences = events.map((event) => event.sequence)
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index] > sequences[index - 1], 'sequence must strictly increase')
  }
})
