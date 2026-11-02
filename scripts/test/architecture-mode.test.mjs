import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveArchitecture } from '../lib/architecture-mode.mjs'

test('defaults to T1 when neither args nor environment select a mode', () => {
  assert.equal(resolveArchitecture([], {}), 't1')
  assert.equal(resolveArchitecture(['--mode', 'development', '--profile', 'local'], {}), 't1')
})

test('selects E1 with -e1 and every documented alias', () => {
  for (const argument of ['-e1', '--e1', '--arch=e1', '--architecture=e1']) {
    assert.equal(resolveArchitecture([argument], {}), 'e1')
  }
  assert.equal(resolveArchitecture(['--arch', 'e1'], {}), 'e1')
  assert.equal(resolveArchitecture(['--architecture', 'E1'], {}), 'e1')
  assert.equal(resolveArchitecture([], { OPENLINK_ARCHITECTURE: 'e1' }), 'e1')
})

test('selects T2 preview with -t2 and every documented alias', () => {
  for (const argument of ['-t2', '--t2', '--arch=t2', '--architecture=t2']) {
    assert.equal(resolveArchitecture([argument], {}), 't2')
  }
  assert.equal(resolveArchitecture(['--arch', 't2'], {}), 't2')
  assert.equal(resolveArchitecture(['--architecture', 'T2'], {}), 't2')
  assert.equal(resolveArchitecture([], { OPENLINK_ARCHITECTURE: 't2' }), 't2')
})

test('explicit T1 arguments override an E1 environment default', () => {
  assert.equal(resolveArchitecture(['-t1'], { OPENLINK_ARCHITECTURE: 'e1' }), 't1')
  assert.equal(resolveArchitecture(['--arch', 't1'], { OPENLINK_ARCHITECTURE: 'e1' }), 't1')
})

test('rejects an unknown or missing architecture value', () => {
  assert.throws(() => resolveArchitecture(['--arch', 't3'], {}), /t1, t2 or e1/)
  assert.throws(() => resolveArchitecture(['--arch'], {}), /t1, t2 or e1/)
  assert.throws(() => resolveArchitecture([], { OPENLINK_ARCHITECTURE: 't3' }), /t1, t2 or e1/)
})
