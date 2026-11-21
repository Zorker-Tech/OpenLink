import assert from 'node:assert/strict'
import test from 'node:test'
import { createTimelineTimeFormatter, foldTimeline } from '../../packages/zorker-bot-demo/dist/app/timeline-rows.js'
import { createMessageMentionMatcher, splitMessagePrompt } from '../../lib/bot-message-content.ts'
import { decodeBotTimelineCache, encodeBotTimelineCache, mergeBotTimelineSnapshot } from '../../lib/bot-transcript-cache.ts'

import {
  OPTIMISTIC_USER_ENTRY_PREFIX,
  fromDurableGroupEntry,
  normalizeWorkHostEntry,
  optimisticUserEntry,
  reconcileOptimisticUserEntry,
  toDurableGroupEntry,
  toWorkHostEntry,
} from '../../lib/bot-transcript.ts'

function user(id, timestampMs, content = id) {
  return { kind: 'user-message', id, content, timestampMs }
}

function agent(id, timestampMs, content = id) {
  return { kind: 'agent-message', id, content, timestampMs }
}

test('timeline cache stores a bounded stable tail and restores only matching work identities', () => {
  const bot = { id: 'room', workAgentId: 'agent', runtimeStatus: 'ready', kind: 'bot' }
  const transcript = Array.from({ length: 100 }, (_, index) => user(`m${index}`, index + 1))
  const optimistic = optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}unsent`, 'draft')
  const encoded = encodeBotTimelineCache([{ ...bot, transcript: [...transcript, optimistic] }])
  assert.deepEqual(decodeBotTimelineCache(encoded, [bot]).room.transcript, transcript.slice(-80))
  assert.deepEqual(decodeBotTimelineCache(encoded, [{ ...bot, workAgentId: 'different' }]), {})
  assert.deepEqual(decodeBotTimelineCache(encoded, []), {})
})

test('a full snapshot preserves an intervening stream update and reconciles optimistic sends by nonce', () => {
  const original = user('m1', 1)
  const updated = { ...original, reactions: [{ emoji: '👍', by: 'me' }] }
  const later = agent('m2', 2)
  const optimistic = { ...optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}nonce`, 'hello'), clientNonce: 'nonce' }
  const accepted = { ...user('m3', 3, 'hello'), clientNonce: 'nonce' }
  const result = mergeBotTimelineSnapshot([original, accepted], [original], [updated, later, optimistic])
  assert.deepEqual(result, [updated, accepted, later])
})

test('prompt links and group mentions preserve the original text, punctuation and whitespace', () => {
  const mentions = createMessageMentionMatcher([
    { id: 'one', name: 'Ada' },
    { id: 'two', name: 'Ada (Research)' },
    { id: 'three', name: 'Sam' },
    { id: 'four', name: 'Sam' },
  ])
  const content = '**Keep this**\n@Ada (Research) https://example.com/@Ada。 Email a@Ada. @Sam'
  const parts = splitMessagePrompt(content, mentions)
  assert.equal(parts.map(part => part.value).join(''), content)
  assert.deepEqual(parts.filter(part => part.kind !== 'text'), [
    { kind: 'mention', value: '@Ada (Research)', id: 'two' },
    { kind: 'link', value: 'https://example.com/@Ada' },
  ])
})

test('historical assistant control markers and drafts stay out of the timeline', () => {
  const marker = '{"message":null}'
  assert.equal(normalizeWorkHostEntry({ id: 'hidden-1', kind: 'message', role: 'assistant', content: marker }), null)
  assert.equal(normalizeWorkHostEntry({ id: 'hidden-2', kind: 'message', role: 'assistant', content: 'Draft', isStreaming: true }), null)
  assert.equal(fromDurableGroupEntry(agent('hidden-3', 1, marker)), null)
  assert.equal(normalizeWorkHostEntry({ id: 'visible', kind: 'message', role: 'user', content: marker })?.content, marker)
})

test('the durable user echo replaces the optimistic bubble in place', () => {
  const optimistic = optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}nonce`, 'hi')
  const durable = user('user-message-1', 2, 'hi')
  const result = reconcileOptimisticUserEntry([agent('agent-1', 1), optimistic], durable)
  assert.deepEqual(result.map((entry) => entry.id), ['agent-1', 'user-message-1'])
  assert.equal(result[1], durable)
})

test('the receipt for one send preserves the separate reference of an identical pending send', () => {
  const first = { ...optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}first-send`, 'Continue', 'target-1'), clientNonce: 'first-send' }
  const second = { ...optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}second-send`, 'Continue', 'target-2'), clientNonce: 'second-send' }
  const echo = normalizeWorkHostEntry({ kind: 'message', role: 'user', id: 'second', content: 'Continue', clientNonce: 'second-send', replyTo: 'target-2' })
  assert.deepEqual(reconcileOptimisticUserEntry([first, second], echo).map(entry => [entry.id, entry.replyTo]), [
    [first.id, 'target-1'], ['second', 'target-2'],
  ])
})

test('assistant reply references support host receipts and message metadata', () => {
  const firstReply = normalizeWorkHostEntry({ kind: 'send-message', id: 'first', hostReceipt: true, firstBotReplyTo: 'original', message: { type: 'text', content: 'On it' } })
  const quoted = normalizeWorkHostEntry({ kind: 'send-message', id: 'follow-up', message: { type: 'text', content: 'Here is the result', replyTo: 'original' } })
  assert.equal(firstReply?.replyTo, 'original')
  assert.equal(quoted?.replyTo, 'original')
})

test('an echo that arrives before the optimistic copy does not duplicate it', () => {
  const durable = user('user-message-1', 2, 'hi')
  const optimistic = optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}nonce`, 'hi')
  const first = reconcileOptimisticUserEntry([durable], durable)
  assert.deepEqual(first, [durable])
  const second = reconcileOptimisticUserEntry([...first, optimistic], durable)
  assert.deepEqual(second.map((entry) => entry.id), ['user-message-1'])
})

test('reply targets and media labels survive transcript recovery', () => {
  const target = normalizeWorkHostEntry({
    kind: 'send-message', id: 'snapshot', timestampMs: 10,
    message: { type: 'image', alt: 'Dashboard' }, requestId: 'request-1',
  })
  const optimistic = optimisticUserEntry(`${OPTIMISTIC_USER_ENTRY_PREFIX}reply`, 'Use this view', target.id)
  const reply = normalizeWorkHostEntry({
    kind: 'message', role: 'user', id: 'reply', content: 'Use this view',
    timestampMs: 20, replyTo: target.id,
  })
  assert.equal(optimistic.replyTo, reply.replyTo)
  assert.deepEqual(reconcileOptimisticUserEntry([target, optimistic], reply), [target, reply])
  for (const entry of [target, reply]) {
    assert.deepEqual(normalizeWorkHostEntry(toWorkHostEntry(entry)), entry)
    assert.deepEqual(fromDurableGroupEntry(toDurableGroupEntry(entry).payload), entry)
  }
})

test('timeline batches attachments by sender and collapses adjacent tool calls without losing anchors', () => {
  const attachment = (id, timestampMs, role = 'user-message') => ({
    ...user(id, timestampMs), kind: role, attachment: { name: `${id}.pdf`, kind: 'file', batchId: 'batch' },
  })
  const tool = (id, timestampMs) => ({
    kind: 'activity', id, timestampMs, activity: { tool: 'tool', label: id, status: 'done' },
  })
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', dateStyle: 'short' })
  const rows = foldTimeline([
    attachment('one', 1), attachment('two', 2), attachment('agent-file', 3, 'agent-message'),
    tool('read', 4), tool('edit', 5), user('question', 6), tool('isolated', 20 * 60_000),
  ], day, 3)
  assert.deepEqual(rows.map((row) => [row.kind, row.entries.map(({ id }) => id), row.unread, row.timestamp]), [
    ['attachments', ['one', 'two'], false, 1],
    ['attachments', ['agent-file'], false, undefined],
    ['tools', ['read', 'edit'], true, undefined],
    ['entry', ['question'], false, undefined],
    ['tools', ['isolated'], false, 20 * 60_000],
  ])
})

test('timeline labels each date boundary once in the local calendar', () => {
  const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York' })
  const at = (value) => Date.parse(value)
  const format = createTimelineTimeFormatter('en-US', day, at('2026-11-02T05:30:00Z'))
  const rows = foldTimeline([
    user('old', at('2025-10-31T13:00:00Z')),
    user('first-yesterday', at('2026-11-01T04:30:00Z')),
    user('later-yesterday', at('2026-11-01T08:25:00Z')),
    user('first-today', at('2026-11-02T05:12:00Z')),
    user('later-today', at('2026-11-02T05:35:00Z')),
  ], day)
  assert.deepEqual(rows.map(({ dayStart }) => dayStart), ['initial', 'boundary', undefined, 'boundary', undefined])
  const labels = rows.map(({ timestamp, dayStart }) => format(timestamp, dayStart))
  assert.match(labels[0], /Oct 31, 2025/)
  assert.match(labels[1], /^yesterday · 12:30/)
  assert.match(labels[2], /^3:25\sAM$/)
  assert.match(labels[3], /^today · 12:12/)
  assert.match(labels[4], /^12:35\sAM$/)
  assert.match(format(rows[3].timestamp, 'initial'), /^12:12\sAM$/)
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

test('reactions keep their author and survive the durable projection', () => {
  const normalized = normalizeWorkHostEntry({
    id: 'agent-1',
    kind: 'send-message',
    message: { type: 'text', content: 'Done' },
    reactions: [
      { emoji: '👍', by: 'me' },
      { emoji: '👍', by: 'teammate' },
      { emoji: '🎉', by: 'me' },
      { emoji: '👍', by: 'me' },
    ],
    timestampMs: 10,
  })
  assert.deepEqual(normalized.reactions, [
    { emoji: '👍', by: 'me' },
    { emoji: '👍', by: 'teammate' },
    { emoji: '🎉', by: 'me' },
  ])
  const durable = toWorkHostEntry(normalized)
  assert.deepEqual(durable.reactions, normalized.reactions)
  const restored = normalizeWorkHostEntry(durable)
  assert.deepEqual(restored.reactions, normalized.reactions)
})

test('legacy string reactions become reactions from the current viewer', () => {
  const normalized = normalizeWorkHostEntry({
    id: 'user-1',
    kind: 'message',
    role: 'user',
    content: 'Ship it',
    reactions: ['👍', '🎉'],
    timestampMs: 10,
  })
  assert.deepEqual(normalized.reactions, [
    { emoji: '👍', by: 'me' },
    { emoji: '🎉', by: 'me' },
  ])
})
