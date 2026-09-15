import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldSubmitPromptOnEnter } from '../../lib/prompt-keyboard.ts'

test('plain Enter submits while Shift+Enter remains a newline', () => {
  assert.equal(shouldSubmitPromptOnEnter({ key: 'Enter', keyCode: 13, shiftKey: false, isComposing: false }), true)
  assert.equal(shouldSubmitPromptOnEnter({ key: 'Enter', keyCode: 13, shiftKey: true, isComposing: false }), false)
})

test('IME candidate confirmation never submits the prompt', () => {
  assert.equal(shouldSubmitPromptOnEnter({ key: 'Enter', keyCode: 13, shiftKey: false, isComposing: true }), false)
  assert.equal(shouldSubmitPromptOnEnter({ key: 'Enter', keyCode: 229, shiftKey: false, isComposing: false }), false)
})

test('non-Enter keys do not submit', () => {
  assert.equal(shouldSubmitPromptOnEnter({ key: 'Escape', keyCode: 27, shiftKey: false, isComposing: false }), false)
})
