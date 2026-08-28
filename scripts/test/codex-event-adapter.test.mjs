import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexEventAdapter } from '../../lib/agent-runtime/codex-event-adapter.ts'

const adapter = () => new CodexEventAdapter('TESTSESS01', () => '2026-01-01T00:00:00Z', 100)
const kinds = (events) => events.map((event) => event.type)

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
    'status.updated',
    'message.delta',
    'message.delta',
    'message.completed',
    'command.started',
    'command.completed',
    'status.updated',
    'session.completed',
  ])
  assert.equal(all[1].delta, 'Hello')
  assert.equal(all[2].delta, ' world')
  assert.equal(all[3].text, 'Hello world')
  assert.equal(all[4].command, 'ls')
  assert.equal(all[5].exitCode, 0)
  assert.equal(all[7].type, 'session.completed')
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

test('approval requests surface as confirmation.requested', () => {
  const events = adapter().adapt({
    method: 'execCommandApproval',
    params: { conversationId: 't1', callId: 'c9', command: ['rm', '-rf', 'node_modules'] },
  })
  assert.deepEqual(kinds(events), ['confirmation.requested'])
  assert.match(events[0].message, /rm -rf node_modules/)
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
