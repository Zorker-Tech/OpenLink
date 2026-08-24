import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasPersistedUserMessage,
  shouldAutoStartInitialPrompt,
} from '../../lib/chat-auto-start.ts'

const event = (type) => ({ type })

test('starts a requested initial prompt when no user turn is durable', () => {
  assert.equal(shouldAutoStartInitialPrompt('1', 'hello', []), true)
  assert.equal(shouldAutoStartInitialPrompt('1', 'hello', [event('session.started')]), true)
})

test('does not restart an initial prompt after its user turn is durable', () => {
  const persisted = [event('message.user'), event('message.completed')]
  assert.equal(hasPersistedUserMessage(persisted), true)
  assert.equal(shouldAutoStartInitialPrompt('1', 'hello', persisted), false)
})

test('does not auto-start without the one-shot query flag or a prompt', () => {
  assert.equal(shouldAutoStartInitialPrompt(undefined, 'hello', []), false)
  assert.equal(shouldAutoStartInitialPrompt('0', 'hello', []), false)
  assert.equal(shouldAutoStartInitialPrompt('1', '   ', []), false)
})

test('message text is not used for de-duplication', () => {
  assert.equal(hasPersistedUserMessage([event('message.user'), event('message.user')]), true)
  // This helper only gates the initial one-shot run. Normal message submission
  // does not call it, so users remain free to send identical text deliberately.
  assert.equal(shouldAutoStartInitialPrompt(undefined, 'same text', [event('message.user')]), false)
})
