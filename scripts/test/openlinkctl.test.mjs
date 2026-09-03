import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installReleaseDirectory } from '../../deploy/self-hosted/openlinkctl.mjs'
import {
  createReleaseInventory,
  normalizeTarget,
  signReleaseManifest,
} from '../lib/self-hosted-release.mjs'

async function fixture(t, releaseId = '2026.09.03-test.1') {
  const root = await mkdtemp(join(tmpdir(), 'openlinkctl-test-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const installRoot = join(root, 'install')
  await mkdir(join(source, 'bin'), { recursive: true })
  await writeFile(join(source, 'bin', 'openlinkctl'), '#!/bin/sh\n', { mode: 0o755 })
  const inventory = await createReleaseInventory(source)
  const keys = generateKeyPairSync('ed25519')
  const signedManifest = signReleaseManifest({
    schemaVersion: 1,
    product: 'OpenLink',
    releaseId,
    target: normalizeTarget({ platform: process.platform, architecture: process.arch }),
    inventory,
  }, { privateKey: keys.privateKey, keyId: 'test-release-key' })
  await writeFile(join(source, 'release.json'), `${JSON.stringify(signedManifest, null, 2)}\n`, { mode: 0o644 })
  return { root, source, installRoot, keys, signedManifest }
}

test('installs a verified release immutably and atomically activates current', async (t) => {
  const item = await fixture(t)
  const result = await installReleaseDirectory({
    source: item.source,
    installRoot: item.installRoot,
    trustedKeys: { 'test-release-key': item.keys.publicKey },
    expectedTarget: { platform: process.platform, architecture: process.arch },
  })
  assert.equal(result.releaseId, item.signedManifest.releaseId)
  assert.equal((await lstat(join(item.installRoot, 'current'))).isSymbolicLink(), true)
  assert.equal(await readFile(join(item.installRoot, 'current', 'bin', 'openlinkctl'), 'utf8'), '#!/bin/sh\n')
})

test('rejects an immutable release collision with different bytes', async (t) => {
  const item = await fixture(t)
  const options = {
    source: item.source,
    installRoot: item.installRoot,
    trustedKeys: { 'test-release-key': item.keys.publicKey },
    expectedTarget: { platform: process.platform, architecture: process.arch },
  }
  await installReleaseDirectory(options)
  await writeFile(join(item.installRoot, 'releases', item.signedManifest.releaseId, 'bin', 'openlinkctl'), 'changed\n')
  await assert.rejects(installReleaseDirectory(options), /immutable|collision|digest/i)
})

test('does not activate a bundle for a different platform', async (t) => {
  const item = await fixture(t)
  const wrongTarget = process.platform === 'darwin'
    ? { platform: 'linux', architecture: 'x64' }
    : { platform: 'darwin', architecture: 'arm64' }
  await assert.rejects(installReleaseDirectory({
    source: item.source,
    installRoot: item.installRoot,
    trustedKeys: { 'test-release-key': item.keys.publicKey },
    expectedTarget: wrongTarget,
  }), /target/i)
  await assert.rejects(lstat(join(item.installRoot, 'current')), /ENOENT/)
})

