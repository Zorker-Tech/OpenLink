import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PRODUCT_VERSION, releaseChannel, releaseCodename, releaseName } from '../lib/release-version.mjs'

const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const versionFile = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim()

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

test('keeps VERSION, package.json and every release name on the shared version', () => {
  assert.equal(versionFile, PRODUCT_VERSION)
  assert.equal(packageVersion, PRODUCT_VERSION)
  for (const architecture of ['t1', 't2', 'e1']) {
    const codename = releaseCodename(architecture)
    assert.equal(releaseName(architecture), `${architecture.toUpperCase()}-${codename ? `${codename}-` : ''}${PRODUCT_VERSION}`)
  }
})
