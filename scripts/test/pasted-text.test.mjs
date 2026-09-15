import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPastedTextAttachment,
  insertRestoredPastedText,
  PASTED_TEXT_ATTACHMENT_MAX_BYTES,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  shouldAttachPastedText,
} from '../../lib/agent-runtime/pasted-text.ts'

test('only large bounded text becomes a pasted-text attachment', () => {
  assert.equal(shouldAttachPastedText('a'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD - 1)), false)
  assert.equal(shouldAttachPastedText('a'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD)), true)
  assert.equal(createPastedTextAttachment('a'.repeat(PASTED_TEXT_ATTACHMENT_MAX_BYTES + 1)), null)
  assert.deepEqual(createPastedTextAttachment('a'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD)), {
    type: 'text',
    mediaType: 'text/plain',
    text: 'a'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD),
    filename: '已粘贴的文本.txt',
  })
})

test('restoring pasted text replaces the active selection and returns its caret', () => {
  assert.deepEqual(insertRestoredPastedText('before OLD after', 'new', 7, 10), {
    value: 'before new after',
    cursor: 10,
  })
})
