import assert from 'node:assert/strict'
import test from 'node:test'
import { PRODUCT_VERSION, releaseChannel, releaseCodename, releaseName } from '../lib/release-version.mjs'

test('uses one shared semantic product version for the stable and preview channels', () => {
  assert.equal(PRODUCT_VERSION, '0.0.1')
  assert.equal(releaseName('t1'), 'T1-Crab-0.0.1')
  assert.equal(releaseName('t2'), 'T2-Orion-0.0.1')
  assert.equal(releaseCodename('t1'), 'Crab')
  assert.equal(releaseCodename('t2'), 'Orion')
  assert.equal(releaseChannel('t1'), 'stable')
  assert.equal(releaseChannel('t2'), 'preview')
})

test('keeps E1 as a compatibility mode without a T1/T2 codename', () => {
  assert.equal(releaseName('e1'), 'E1-0.0.1')
  assert.equal(releaseCodename('e1'), null)
  assert.equal(releaseChannel('e1'), 'compatibility')
})

test('rejects an unknown architecture', () => {
  assert.throws(() => releaseName('t3'), /t1, t2 or e1/)
})
