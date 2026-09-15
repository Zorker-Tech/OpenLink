import assert from 'node:assert/strict'
import test from 'node:test'

import { runtimePublicConfig } from '../../utils/supabase/client.ts'

function withDocument(element, callback) {
  const previous = globalThis.document
  globalThis.document = {
    querySelector: () => element,
  }
  try {
    return callback()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

test('uses the runtime endpoint rendered by the production supervisor', () => {
  const element = { getAttribute: () => 'http://127.0.0.1:54380' }
  assert.equal(withDocument(element, () => runtimePublicConfig('openlink-supabase-url', 'https://cloud.invalid')), 'http://127.0.0.1:54380')
})

test('self-hosted runtime configuration fails closed instead of falling back to cloud', () => {
  const element = { getAttribute: () => '' }
  assert.throws(
    () => withDocument(element, () => runtimePublicConfig('openlink-supabase-url', 'https://cloud.invalid')),
    /runtime configuration is missing openlink-supabase-url/,
  )
})

test('build fallback remains available when no runtime document exists', () => {
  const previous = globalThis.document
  delete globalThis.document
  try {
    assert.equal(runtimePublicConfig('openlink-supabase-url', 'https://cloud.example'), 'https://cloud.example')
  } finally {
    if (previous !== undefined) globalThis.document = previous
  }
})
