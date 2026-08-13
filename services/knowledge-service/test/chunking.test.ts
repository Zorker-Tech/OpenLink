import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../src/chunking.js'

test('chunkText is deterministic and keeps overlap bounded', () => {
  const chunks = chunkText('one two three four five six seven eight nine ten', 18, 4)
  assert.ok(chunks.length > 1)
  assert.equal(chunks[0]?.index, 0)
  assert.ok(chunks.every((chunk) => chunk.content.length <= 18))
  assert.equal(chunkText('  hello  ', 100, 2)[0]?.content, 'hello')
})
