import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreviewTargetId, isPreviewTargetId } from '../src/preview-target-id.js'

test('preview target identifiers are stable, opaque, and Project scoped', () => {
  const secret = 'project-api-key-with-sufficient-length'
  const id = createPreviewTargetId(secret, 'project-a', 'sandbox-123', 5173)

  assert.equal(id.length, 43)
  assert.equal(isPreviewTargetId(id), true)
  assert.equal(createPreviewTargetId(secret, 'project-a', 'sandbox-123', 5173), id)
  assert.notEqual(createPreviewTargetId(secret, 'project-b', 'sandbox-123', 5173), id)
  assert.notEqual(createPreviewTargetId(secret, 'project-a', 'sandbox-456', 5173), id)
  assert.notEqual(createPreviewTargetId(secret, 'project-a', 'sandbox-123', 3000), id)
  assert.equal(id.includes('sandbox-123'), false)
})

test('preview target identifiers reject invalid secrets and coordinates', () => {
  assert.throws(() => createPreviewTargetId('short', 'project-a', 'sandbox-123', 5173), /SECRET_INVALID/)
  assert.throws(() => createPreviewTargetId('a sufficiently long secret value', 'project-a', '', 5173), /INPUT_INVALID/)
  assert.throws(() => createPreviewTargetId('a sufficiently long secret value', 'project-a', 'sandbox-123', 0), /INPUT_INVALID/)
  assert.equal(isPreviewTargetId('sandbox-123:5173'), false)
  assert.equal(isPreviewTargetId('A'.repeat(42)), false)
})
