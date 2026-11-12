import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOT_GROUP_MAX_MEMBERS,
  isGroupPassReply,
  normalizeGroupMemberIds,
  resolveGroupResponders,
} from '../../lib/bot-groups.ts'

const members = [
  { id: 'b1', name: 'Scout' },
  { id: 'b2', name: 'Inbox Manager' },
  { id: 'b3', name: 'Ada' },
]

test('group members are deduplicated, trimmed, and capped', () => {
  const ids = normalizeGroupMemberIds([
    ' b1 ',
    'b2',
    'b1',
    '',
    ...Array.from({ length: 10 }, (_, index) => `extra-${index}`),
  ])
  assert.equal(ids.length, BOT_GROUP_MAX_MEMBERS)
  assert.deepEqual(ids.slice(0, 2), ['b1', 'b2'])
})

test('an explicit member mention selects only that member', () => {
  assert.deepEqual(
    resolveGroupResponders(members, 'Scout, take the first pass please').map((member) => member.id),
    ['b1', 'b2', 'b3'],
  )
  assert.deepEqual(
    resolveGroupResponders(members, '@Scout take the first pass').map((member) => member.id),
    ['b1'],
  )
})

test('@everyone selects every member and mentions are case insensitive', () => {
  assert.deepEqual(
    resolveGroupResponders(members, '@everyone check the inbox').map((member) => member.id),
    ['b1', 'b2', 'b3'],
  )
  assert.deepEqual(
    resolveGroupResponders(members, '@inbox manager please review').map((member) => member.id),
    ['b2'],
  )
})

test('a turn without a mention addresses the whole group', () => {
  assert.deepEqual(
    resolveGroupResponders(members, 'Plan the offsite').map((member) => member.mentioned),
    [false, false, false],
  )
})

test('pass replies are recognised without swallowing normal text', () => {
  assert.equal(isGroupPassReply('pass'), true)
  assert.equal(isGroupPassReply('(pass)'), true)
  assert.equal(isGroupPassReply('  '), true)
  assert.equal(isGroupPassReply('I will pass the deck to Ada'), false)
})
