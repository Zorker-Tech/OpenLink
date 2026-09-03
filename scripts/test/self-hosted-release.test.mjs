import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalJson,
  createReleaseInventory,
  normalizeReleaseId,
  normalizeTarget,
  parseReleaseTrustRoot,
  signReleaseManifest,
  verifyReleaseInventory,
  verifyReleaseManifest,
} from '../../deploy/self-hosted/runtime/release-contract.mjs'

test('trust roots authorize only active Ed25519 keys inside their validity window', () => {
  const keys = Object.fromEntries(['active', 'revoked', 'retired', 'expired', 'future'].map((name) => [name, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })]))
  const trusted = parseReleaseTrustRoot({
    schemaVersion: 1,
    minimumReleaseSequence: 1,
    keys: {
      active: { algorithm: 'Ed25519', status: 'active', publicKeyPem: keys.active, notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' },
      revoked: { algorithm: 'Ed25519', status: 'revoked', publicKeyPem: keys.revoked },
      retired: { algorithm: 'Ed25519', status: 'retired', publicKeyPem: keys.retired },
      expired: { algorithm: 'Ed25519', status: 'active', publicKeyPem: keys.expired, notAfter: '2025-01-01T00:00:00.000Z' },
      future: { algorithm: 'Ed25519', status: 'active', publicKeyPem: keys.future, notBefore: '2027-01-01T00:00:00.000Z' },
    },
  }, { now: Date.parse('2026-09-03T00:00:00.000Z') })
  assert.deepEqual(Object.keys(trusted), ['active'])
  assert.throws(() => parseReleaseTrustRoot({ schemaVersion: 1, minimumReleaseSequence: 1, keys: { revoked: { algorithm: 'Ed25519', status: 'revoked', publicKeyPem: keys.revoked } } }), /no currently active keys/i)
})

test('normalizes supported native release identities', () => {
  assert.equal(normalizeReleaseId('2026.09.03-rc.1'), '2026.09.03-rc.1')
  assert.deepEqual(normalizeTarget({ platform: 'darwin', architecture: 'arm64' }), {
    platform: 'darwin',
    architecture: 'arm64',
    provider: 'applehv',
    diskFormat: 'raw',
    triple: 'darwin-arm64',
  })
  assert.deepEqual(normalizeTarget({ platform: 'linux', architecture: 'x64' }), {
    platform: 'linux',
    architecture: 'amd64',
    provider: 'qemu',
    diskFormat: 'qcow2',
    triple: 'linux-amd64',
  })
  assert.throws(() => normalizeReleaseId('../escape'), /release id/i)
  assert.throws(() => normalizeTarget({ platform: 'linux', architecture: 's390x' }), /unsupported/i)
})

test('canonical JSON is deterministic at every object level', () => {
  const left = { z: 1, a: { y: 2, b: [{ d: 4, c: 3 }] } }
  const right = { a: { b: [{ c: 3, d: 4 }], y: 2 }, z: 1 }
  assert.equal(canonicalJson(left), canonicalJson(right))
  assert.equal(canonicalJson(left), '{"a":{"b":[{"c":3,"d":4}],"y":2},"z":1}')
})

test('inventory verifies file modes, sizes and digests and detects tampering', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-release-inventory-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(root, 'bin', 'openlinkctl'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(root, 'NOTICE'), 'OpenLink\n', { mode: 0o644 })

  const inventory = await createReleaseInventory(root)
  assert.deepEqual(inventory.map((entry) => entry.path), ['NOTICE', 'bin/openlinkctl'])
  await verifyReleaseInventory(root, inventory)

  await writeFile(join(root, 'NOTICE'), 'tampered\n')
  await assert.rejects(verifyReleaseInventory(root, inventory), /digest|size/i)
})

test('inventory rejects symbolic links instead of following them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-release-symlink-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'real'), 'data')
  await symlink('real', join(root, 'alias'))
  await assert.rejects(createReleaseInventory(root), /symbolic link/i)
})

test('signed manifests reject tampering, unknown keys and the wrong native target', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const manifest = {
    schemaVersion: 1,
    contractVersion: 1,
    product: 'OpenLink',
    releaseId: '2026.09.03-rc.1',
    releaseSequence: 1,
    target: normalizeTarget({ platform: 'darwin', architecture: 'arm64' }),
    inventory: [{ path: 'NOTICE', mode: '0644', size: 9, sha256: 'a'.repeat(64) }],
    compatibility: { stateSchema: 1, minimumStateSchema: 1, maximumStateSchema: 1 },
  }
  const signed = signReleaseManifest(manifest, {
    privateKey,
    keyId: 'release-2026-01',
  })
  assert.equal(verifyReleaseManifest(signed, {
    trustedKeys: { 'release-2026-01': publicKey },
    expectedTarget: { platform: 'darwin', architecture: 'arm64' },
  }).releaseId, manifest.releaseId)
  assert.throws(() => verifyReleaseManifest(signed, {
    trustedKeys: { 'release-2026-01': publicKey },
    expectedTarget: { platform: 'darwin', architecture: 'arm64' },
    minimumReleaseSequence: 2,
  }), /below the trusted minimum/i)
  assert.throws(() => verifyReleaseManifest({ ...signed, releaseId: 'tampered' }, {
    trustedKeys: { 'release-2026-01': publicKey },
    expectedTarget: { platform: 'darwin', architecture: 'arm64' },
  }), /signature/i)
  assert.throws(() => verifyReleaseManifest(signed, {
    trustedKeys: {},
    expectedTarget: { platform: 'darwin', architecture: 'arm64' },
  }), /trusted|key/i)
  assert.throws(() => verifyReleaseManifest(signed, {
    trustedKeys: { 'release-2026-01': publicKey },
    expectedTarget: { platform: 'linux', architecture: 'x64' },
  }), /target/i)
})
