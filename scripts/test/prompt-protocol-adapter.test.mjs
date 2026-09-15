import assert from 'node:assert/strict'
import test from 'node:test'

import { piPromptProtocolInput } from '../../services/agent-worker/src/prompt-protocol.ts'

test('Pi receives every OpenLink input kind through one protocol adapter', () => {
  const result = piPromptProtocolInput('Review these inputs.', [
    { type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' },
    { type: 'text', mediaType: 'text/plain', filename: 'notes.txt', text: 'pasted context' },
    { type: 'instruction', name: 'Project instructions', text: 'Keep changes local.' },
    { type: 'reference', referenceType: 'file', name: 'app.ts', path: 'src/app.ts' },
    { type: 'reference', referenceType: 'thread', name: 'Earlier task', path: 'thread://task-1' },
  ], [{ name: 'data.csv', path: '.openlink/uploads/batch/data.csv' }])

  assert.deepEqual(result.images, [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
  for (const text of ['Review these inputs.', 'pasted context', 'Keep changes local.', 'src/app.ts', 'thread://task-1', '.openlink/uploads/batch/data.csv']) {
    assert.match(result.message, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})
