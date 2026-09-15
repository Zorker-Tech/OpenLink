import test from 'node:test'
import assert from 'node:assert/strict'
import { chromiumSingletonOwner, isProcessSingletonFailure } from '../src/chromium-runtime.js'

test('parses Chromium singleton owners across container restarts', () => {
  assert.deepEqual(chromiumSingletonOwner('35143241809c-127'), {
    hostname: '35143241809c',
    pid: 127,
  })
  assert.deepEqual(chromiumSingletonOwner('browser-host-with-dashes-42'), {
    hostname: 'browser-host-with-dashes',
    pid: 42,
  })
})

test('rejects ambiguous or unsafe Chromium singleton owner targets', () => {
  assert.equal(chromiumSingletonOwner('missing-pid'), null)
  assert.equal(chromiumSingletonOwner('host-1'), null)
  assert.equal(chromiumSingletonOwner('-123'), null)
  assert.equal(chromiumSingletonOwner('host-not-a-number'), null)
})

test('recognizes Chromium 152 process singleton failures', () => {
  assert.equal(isProcessSingletonFailure(new Error(
    'process_singleton_posix.cc:365 The profile appears to be in use by another Chromium process (127) on another computer',
  )), true)
  assert.equal(isProcessSingletonFailure(new Error('browser navigation timed out')), false)
})
