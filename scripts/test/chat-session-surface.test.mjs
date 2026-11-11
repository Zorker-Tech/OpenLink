import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isBotChatSession,
  isChatSessionSurface,
  isCodeChatSession,
} from '../../lib/chat-session-surface.ts'

test('the shared session vocabulary accepts exactly the two product surfaces', () => {
  assert.equal(isChatSessionSurface('code'), true)
  assert.equal(isChatSessionSurface('bot'), true)
  assert.equal(isChatSessionSurface('admin'), false)
  assert.equal(isChatSessionSurface(undefined), false)
})

test('Code and Bot discrimination is explicit and non-overlapping', () => {
  const code = { surface: 'code' }
  const bot = { surface: 'bot' }
  assert.equal(isCodeChatSession(code), true)
  assert.equal(isBotChatSession(code), false)
  assert.equal(isCodeChatSession(bot), false)
  assert.equal(isBotChatSession(bot), true)
})
