import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { archiveName, immutablePullReference, nodeArchitecture, validateImageArtifactManifest } from '../lib/project-supabase-images.mjs'

const platformDigest = `sha256:${'a'.repeat(64)}`
const lock = {
  release: { tag: 'self-hosted/v0.8.0', commit: 'b'.repeat(40) },
  configuration: { treeSha256: 'c'.repeat(64), runtimeSpecSha256: 'e'.repeat(64) },
  services: [{
    name: 'auth',
    image: 'supabase/gotrue:v2.189.0',
    platforms: {
      amd64: { digest: platformDigest, size: 100 },
      arm64: { digest: platformDigest, size: 100 },
    },
  }],
}

test('maps Node architectures and builds immutable pull references', () => {
  assert.equal(nodeArchitecture('x64'), 'amd64')
  assert.equal(nodeArchitecture('arm64'), 'arm64')
  assert.throws(() => nodeArchitecture('riscv64'), /does not support/)
  assert.equal(immutablePullReference('supabase/gotrue:v2.189.0', platformDigest), `supabase/gotrue@${platformDigest}`)
  assert.equal(archiveName(lock.services[0], 'arm64'), `auth-arm64-${'a'.repeat(20)}.docker.tar`)
})

test('validates artifact content, size and SHA-256 against the lock', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'project-supabase-images-'))
  const archive = archiveName(lock.services[0], 'arm64')
  const bytes = Buffer.alloc(2048, 7)
  await writeFile(resolve(root, archive), bytes)
  const { createHash } = await import('node:crypto')
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  const manifest = {
    schemaVersion: 1,
    release: lock.release,
    architecture: 'arm64',
    configurationTreeSha256: lock.configuration.treeSha256,
    images: [{ service: 'auth', image: lock.services[0].image, platformDigest, imageId: `sha256:${'d'.repeat(64)}`, archive, archiveSha256, archiveBytes: bytes.length }],
  }
  assert.equal((await validateImageArtifactManifest(manifest, lock, root)).images.length, 1)
  manifest.images[0].archiveSha256 = 'e'.repeat(64)
  await assert.rejects(() => validateImageArtifactManifest(manifest, lock, root), /archive digest mismatch/)
})
