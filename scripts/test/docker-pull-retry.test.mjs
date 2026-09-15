import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableDockerPullError, retryDockerPull } from '../lib/docker-pull-retry.mjs'

test('retries transient Docker registry failures and eventually succeeds', async () => {
  let calls = 0
  const retries = []
  const result = await retryDockerPull(async () => {
    calls += 1
    if (calls < 3) throw Object.assign(new Error('failed to copy: unexpected EOF'), { stderr: 'TLS connection closed' })
    return 'ready'
  }, {
    attempts: 4,
    sleep: async () => undefined,
    onRetry: (attempt) => retries.push(attempt),
  })
  assert.equal(result, 'ready')
  assert.equal(calls, 3)
  assert.deepEqual(retries, [1, 2])
})

test('does not retry deterministic pull errors', async () => {
  let calls = 0
  await assert.rejects(() => retryDockerPull(async () => {
    calls += 1
    throw new Error('manifest unknown: image not found')
  }, { attempts: 8, sleep: async () => undefined }), /manifest unknown/)
  assert.equal(calls, 1)
  assert.equal(isRetryableDockerPullError(new Error('received HTTP 503')), true)
  assert.equal(isRetryableDockerPullError(new Error('denied: requested access')), false)
})
