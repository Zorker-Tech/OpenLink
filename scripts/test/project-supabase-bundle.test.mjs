import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  bundleFileEntries,
  releaseKeyId,
  signBundleManifest,
  validateBundleManifest,
  verifyBundleFiles,
  verifyBundleManifestSignature,
} from '../lib/project-supabase-bundle.mjs'

const digest = (character) => character.repeat(64)
const lock = {
  release: { tag: 'self-hosted/v0.9.0', commit: 'a'.repeat(40) },
  configuration: { runtimeSpecSha256: digest('b'), treeSha256: digest('c'), upgradesSha256: digest('d') },
  services: [{ name: 'db' }, { name: 'auth' }],
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'project-supabase-bundle-'))
  await mkdir(resolve(root, 'configuration'), { recursive: true })
  await mkdir(resolve(root, 'images'), { recursive: true })
  await writeFile(resolve(root, 'runtime.lock.json'), 'lock')
  await writeFile(resolve(root, 'runtime.spec.json'), 'spec')
  await writeFile(resolve(root, 'configuration/upgrades.json'), 'upgrades')
  await writeFile(resolve(root, 'image-manifest.json'), 'images')
  await writeFile(resolve(root, 'images/db.docker.tar'), Buffer.alloc(32, 1))
  await writeFile(resolve(root, 'images/auth.docker.tar'), Buffer.alloc(32, 2))
  return root
}

test('signs and verifies a complete immutable upgrade bundle', async () => {
  const root = await fixture()
  const files = await bundleFileEntries(root)
  const byPath = (path) => files.find((entry) => entry.path === path).sha256
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
  const manifest = validateBundleManifest({
    schemaVersion: 1,
    product: 'openlink-project-supabase',
    release: lock.release,
    architecture: 'arm64',
    keyId: releaseKeyId(publicPem),
    lockSha256: byPath('runtime.lock.json'),
    runtimeSpecSha256: lock.configuration.runtimeSpecSha256,
    configurationTreeSha256: lock.configuration.treeSha256,
    upgradesSha256: lock.configuration.upgradesSha256,
    imageManifestSha256: byPath('image-manifest.json'),
    files,
  }, lock, 'arm64')
  const signature = signBundleManifest(manifest, privateKey)
  assert.doesNotThrow(() => verifyBundleManifestSignature(manifest, signature, publicPem))
  await verifyBundleFiles(root, manifest)
})

test('rejects tampering, path traversal and unmanifested files', async () => {
  const root = await fixture()
  const files = await bundleFileEntries(root)
  const manifest = {
    schemaVersion: 1,
    product: 'openlink-project-supabase',
    release: lock.release,
    architecture: 'arm64',
    keyId: digest('e'),
    lockSha256: files.find((entry) => entry.path === 'runtime.lock.json').sha256,
    runtimeSpecSha256: lock.configuration.runtimeSpecSha256,
    configurationTreeSha256: lock.configuration.treeSha256,
    upgradesSha256: lock.configuration.upgradesSha256,
    imageManifestSha256: files.find((entry) => entry.path === 'image-manifest.json').sha256,
    files,
  }
  validateBundleManifest(manifest, lock, 'arm64')
  await writeFile(resolve(root, 'runtime.lock.json'), 'tampered')
  await assert.rejects(() => verifyBundleFiles(root, manifest), /size or type mismatch|checksum mismatch/)
  manifest.files[0].path = '../escape'
  assert.throws(() => validateBundleManifest(manifest, lock, 'arm64'), /invalid or duplicated/)
})

test('committed trust root matches its declared Ed25519 key id', async () => {
  const trust = JSON.parse(await readFile(new URL('../../services/project-supabase/release-trust.json', import.meta.url), 'utf8'))
  assert.equal(trust.keys.length, 1)
  assert.equal(releaseKeyId(trust.keys[0].publicKeyPem), trust.keys[0].keyId)
})
