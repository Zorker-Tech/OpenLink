import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installReleaseArchive, installReleaseDirectory } from '../../deploy/self-hosted/openlinkctl.mjs'
import {
  createReleaseInventory,
  normalizeTarget,
  signReleaseManifest,
} from '../../deploy/self-hosted/runtime/release-contract.mjs'
import { parseTarNumber } from '../../deploy/self-hosted/runtime/safe-archive.mjs'

test('safe archive parser accepts positive base-256 sizes and rejects unsafe values', () => {
  const encoded = Buffer.alloc(12)
  encoded[0] = 0x80
  encoded.writeBigUInt64BE(64n * 1024n ** 3n, 4)
  assert.equal(parseTarNumber(encoded, 'file size'), 64 * 1024 ** 3)
  const negative = Buffer.from(encoded)
  negative[0] = 0xc0
  assert.throws(() => parseTarNumber(negative, 'file size'), /negative/i)
  const unsafe = Buffer.alloc(12, 0xff)
  unsafe[0] = 0x80
  assert.throws(() => parseTarNumber(unsafe, 'file size'), /range/i)
})

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
    contractVersion: 1,
    product: 'OpenLink',
    releaseId,
    target: normalizeTarget({ platform: process.platform, architecture: process.arch }),
    inventory,
    compatibility: { stateSchema: 1, minimumStateSchema: 1, maximumStateSchema: 1 },
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

test('installs a signed tar.gz bundle through the safe streaming extractor', async (t) => {
  const item = await fixture(t, '2026.09.03-archive.1')
  const archive = join(item.root, 'release.tar.gz')
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-czf', archive, '-C', item.source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`tar exited ${code}`)))
  })
  const installed = await installReleaseArchive({
    archive,
    installRoot: item.installRoot,
    trustedKeys: { 'test-release-key': item.keys.publicKey },
    expectedTarget: { platform: process.platform, architecture: process.arch },
  })
  assert.equal(installed.releaseId, item.signedManifest.releaseId)
})

test('safe archive install rejects symbolic links before activation', async (t) => {
  const item = await fixture(t, '2026.09.03-archive.2')
  const malicious = join(item.root, 'malicious')
  const archive = join(item.root, 'malicious.tar.gz')
  await mkdir(malicious)
  await (await import('node:fs/promises')).symlink('/tmp', join(malicious, 'escape'))
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-czf', archive, '-C', malicious, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`tar exited ${code}`)))
  })
  await assert.rejects(installReleaseArchive({
    archive,
    installRoot: item.installRoot,
    trustedKeys: { 'test-release-key': item.keys.publicKey },
    expectedTarget: { platform: process.platform, architecture: process.arch },
  }), /forbidden|symbolic|type/i)
  await assert.rejects(lstat(join(item.installRoot, 'current')), /ENOENT/)
})
