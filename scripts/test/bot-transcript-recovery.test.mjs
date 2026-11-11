import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chunkWorkHostEntries,
  mergeBotTranscripts,
  planBotTranscriptRecovery,
  reconcileBotTranscript,
} from '../../lib/bot-transcript.ts'

function user(id, timestampMs, content = id) {
  return { kind: 'user-message', id, content, timestampMs }
}

function agent(id, timestampMs, content = id) {
  return { kind: 'agent-message', id, content, timestampMs }
}

test('a recovered tail is appended without rebuilding the projection', () => {
  const result = reconcileBotTranscript(
    [user('u1', 1), agent('a1', 2)],
    [user('u1', 1), agent('a1', 2), agent('a2', 3)],
  )
  assert.equal(result.requiresRebuild, false)
  assert.deepEqual(result.missing.map((entry) => entry.id), ['a2'])
})

test('an entry missing before the newest stored entry requires an atomic rebuild', () => {
  const result = reconcileBotTranscript(
    [user('u1', 1), agent('a2', 3)],
    [user('u1', 1), agent('a1', 2), agent('a2', 3)],
  )
  assert.equal(result.requiresRebuild, true)
  assert.deepEqual(result.missing.map((entry) => entry.id), ['a1'])
})

test('a same-time missing entry is treated as an ordering gap', () => {
  const result = reconcileBotTranscript(
    [user('u1', 1), agent('a2', 3)],
    [user('u1', 1), agent('a1', 3), agent('a2', 3)],
  )
  assert.equal(result.requiresRebuild, true)
})

test('a lost Work-host store is rebuilt from the durable event log', () => {
  const recovered = [user('u1', 1), agent('a1', 2)]
  const result = reconcileBotTranscript([], recovered)
  assert.equal(result.requiresRebuild, false)
  assert.deepEqual(result.missing.map((entry) => entry.id), ['u1', 'a1'])
})

test('local-only entries survive a merge and retain their order', () => {
  const merged = mergeBotTranscripts(
    [user('u1', 1), agent('local', 4)],
    [user('u1', 1), agent('a1', 2)],
  )
  assert.deepEqual(merged.map((entry) => entry.id), ['u1', 'a1', 'local'])
})

test('large recovery appends are split at the Work-host request limit', () => {
  const entries = Array.from({ length: 1_201 }, (_, index) => agent(`a${index}`, index + 1))
  assert.deepEqual(chunkWorkHostEntries(entries).map((chunk) => chunk.length), [500, 500, 201])
})

test('a fully mirrored transcript does not write during recovery', () => {
  const transcript = [user('u1', 1), agent('a1', 2)]
  const plan = planBotTranscriptRecovery(transcript, transcript)
  assert.equal(plan.action, 'none')
  assert.deepEqual(plan.transcript.map((entry) => entry.id), ['u1', 'a1'])
  assert.deepEqual(plan.appendChunks, [])
  assert.equal(plan.replaceLimitError, null)
})

test('a lost tail produces append chunks without rebuilding', () => {
  const existing = [user('u1', 1), agent('a1', 2)]
  const recovered = [
    ...existing,
    ...Array.from({ length: 1_201 }, (_, index) => agent(`tail-${index}`, 10 + index)),
  ]
  const plan = planBotTranscriptRecovery(existing, recovered)
  assert.equal(plan.action, 'append')
  assert.deepEqual(plan.appendChunks.map((chunk) => chunk.length), [500, 500, 201])
  assert.equal(plan.transcript.length, 1_203)
  assert.equal(plan.transcript.at(-1)?.id, 'tail-1200')
})

test('an ordering gap requires an atomic replacement of the merged transcript', () => {
  const plan = planBotTranscriptRecovery(
    [user('u1', 1), agent('local', 4)],
    [user('u1', 1), agent('a1', 2)],
  )
  assert.equal(plan.action, 'replace')
  assert.deepEqual(plan.transcript.map((entry) => entry.id), ['u1', 'a1', 'local'])
  assert.equal(plan.replaceLimitError, null)
})

test('an over-limit rebuild keeps the complete transcript and reports the limit', () => {
  const existing = Array.from({ length: 10_001 }, (_, index) => agent(`local-${index}`, 20_000 + index))
  const recovered = [user('u1', 1)]
  const plan = planBotTranscriptRecovery(existing, recovered)
  assert.equal(plan.action, 'replace')
  assert.equal(plan.transcript.length, 10_002)
  assert.equal(plan.transcript[0]?.id, 'u1')
  assert.equal(plan.transcript.at(-1)?.id, 'local-10000')
  assert.equal(plan.replaceLimitError?.code, 'WORK_HOST_TRANSCRIPT_REPLACE_LIMIT_EXCEEDED')
  assert.equal(plan.replaceLimitError?.entryCount, 10_002)
})
