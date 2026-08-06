import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserTokenService, assertServiceAuthorization } from '../src/auth.js'

test('capability tokens are scoped, session-bound, and expire', () => {
  let now = 1_000
  const service = new BrowserTokenService('s'.repeat(32), () => now)
  const token = service.issue({ sessionId: 'session-a', ownerId: 'user-a', scopes: ['events'], actors: ['human'], ttlMs: 500 })
  const claims = service.verify(token, 'events', 'session-a')
  assert.equal(claims.ownerId, 'user-a')
  assert.deepEqual(claims.actors, ['human'])
  assert.throws(() => service.verify(token, 'preview', 'session-a'), /lacks preview scope/)
  assert.throws(() => service.verify(token, 'events', 'session-b'), /another session/)
  now = 1_501
  assert.throws(() => service.verify(token, 'events', 'session-a'), /expired/)
})

test('service authorization uses an exact bearer token', () => {
  const token = 'a'.repeat(32)
  assert.doesNotThrow(() => assertServiceAuthorization(`Bearer ${token}`, token))
  assert.throws(() => assertServiceAuthorization(`Bearer ${'b'.repeat(32)}`, token), /invalid/)
  assert.throws(() => assertServiceAuthorization(undefined, token), /required/)
})
