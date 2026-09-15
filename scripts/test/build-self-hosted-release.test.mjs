import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { assembleSelfHostedRelease, dockerArchiveImageId } from '../build-self-hosted-release.mjs'
import { verifyReleaseInventory, verifyReleaseManifest } from '../../deploy/self-hosted/runtime/release-contract.mjs'
import { verifyReleaseArchive } from '../../deploy/self-hosted/openlinkctl.mjs'

const requiredFiles = [
  'runtime/node/bin/node',
  'app/web/server.js',
  'services/agent-host/dist/src/main.js',
  'services/agent-host/dist/src/project-container-main.js',
  'services/agent-host/project-supabase-runtime.mjs',
  'scripts/lib/project-supabase-bundle.mjs',
  'services/browser-host/dist/src/main.js',
  'services/knowledge-service/dist/src/main.js',
  'services/agent-host/dist/src/desktop-main.js',
  'orchestration/backend/docker/docker-compose.yml',
  'orchestration/services/zero/docker-compose.standalone.yml',
  'orchestration/docker-compose.production.yml',
  'orchestration/docker-compose.zero-production.yml',
  'images/runtime/manifest.json',
  'images/zokerbase/manifest.json',
  'images/zero/manifest.json',
  'toolchain/bin/podman',
  'edge/bin/caddy',
  'edge/Caddyfile',
  'browser/manifest.json',
  'browser/chromium/chrome',
  'project-vm/manifest.json',
  'project-vm/openlink-project-vm-base-arm64.raw',
  'project-supabase/manifest.json',
  'project-supabase/runtime.lock.json',
  'project-supabase/runtime.spec.json',
  'project-supabase/image-manifest.json',
  'project-supabase/release-trust.json',
  'openlinkctl.mjs',
  'bin/openlinkctl',
  'systemd/openlink.service', 'systemd/openlink-container-broker.service', 'systemd/openlink-project-container-broker.service',
]
const execFile = promisify(execFileCallback)

async function payloadFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openlink-release-build-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const payload = join(root, 'payload')
  const output = join(root, 'output')
  for (const relative of requiredFiles) {
    const path = join(payload, ...relative.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    const contents = relative === 'browser/manifest.json'
      ? `${JSON.stringify({ target: 'darwin-arm64', executable: 'chromium/chrome' })}\n`
      : `${relative}\n`
    await writeFile(path, contents, { mode: relative.includes('/bin/') || relative === 'bin/openlinkctl' || relative === 'browser/chromium/chrome' ? 0o755 : 0o644 })
  }
  return { root, payload, output }
}

test('assembles a signed native payload with a complete inventory', async (t) => {
  const fixture = await payloadFixture(t)
  const keys = generateKeyPairSync('ed25519')
  const result = await assembleSelfHostedRelease({
    payloadRoot: fixture.payload,
    outputRoot: fixture.output,
    releaseId: '2026.09.03-test.2',
    releaseSequence: 2,
    target: { platform: 'darwin', architecture: 'arm64' },
    privateKey: keys.privateKey,
    keyId: 'fixture-key',
    createArchive: false,
  })
  const signed = JSON.parse(await readFile(join(result.releaseDirectory, 'release.json'), 'utf8'))
  const manifest = verifyReleaseManifest(signed, {
    trustedKeys: { 'fixture-key': keys.publicKey },
    expectedTarget: { platform: 'darwin', architecture: 'arm64' },
  })
  await verifyReleaseInventory(result.releaseDirectory, manifest.inventory)
  assert.equal(result.releaseId, '2026.09.03-test.2')
  assert.equal(result.target, 'darwin-arm64')
  assert.equal(manifest.contractVersion, 1)
})

test('refuses to assemble an incomplete customer runtime', async (t) => {
  const fixture = await payloadFixture(t)
  const keys = generateKeyPairSync('ed25519')
  await (await import('node:fs/promises')).rm(join(fixture.payload, 'app/web/server.js'))
  await assert.rejects(assembleSelfHostedRelease({
    payloadRoot: fixture.payload,
    outputRoot: fixture.output,
    releaseId: '2026.09.03-test.3',
    releaseSequence: 3,
    target: { platform: 'darwin', architecture: 'arm64' },
    privateKey: keys.privateKey,
    keyId: 'fixture-key',
    createArchive: false,
  }), /missing.*app\/web\/server\.js/i)
})

test('derives an immutable Docker image ID from a sealed archive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-image-id-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const digest = 'b'.repeat(64)
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify([{ Config: `${digest}.json`, RepoTags: ['fixture:test'], Layers: [] }])}\n`)
  await writeFile(join(root, `${digest}.json`), '{}\n')
  const archive = join(root, 'image.tar')
  await execFile('tar', ['-cf', archive, '-C', root, 'manifest.json', `${digest}.json`])
  assert.equal(await dockerArchiveImageId(archive), `sha256:${digest}`)
})

test('portable release archives preserve a sparse VM disk as its declared regular path', async (t) => {
  const fixture = await payloadFixture(t)
  const keys = generateKeyPairSync('ed25519')
  await truncate(join(fixture.payload, 'project-vm/openlink-project-vm-base-arm64.raw'), 4 * 1024 * 1024)
  const result = await assembleSelfHostedRelease({
    payloadRoot: fixture.payload,
    outputRoot: fixture.output,
    releaseId: '2026.09.03-sparse-portable',
    releaseSequence: 4,
    target: { platform: 'darwin', architecture: 'arm64' },
    privateKey: keys.privateKey,
    keyId: 'fixture-key',
  })
  const manifest = await verifyReleaseArchive({
    archive: result.archive,
    trustedKeys: { 'fixture-key': keys.publicKey },
    expectedTarget: { platform: 'darwin', architecture: 'arm64' },
  })
  assert.equal(manifest.releaseId, '2026.09.03-sparse-portable')
})

test('refuses private signing material inside a customer payload', async (t) => {
  const fixture = await payloadFixture(t)
  const keys = generateKeyPairSync('ed25519')
  await writeFile(join(fixture.payload, 'release-signing-private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await assert.rejects(assembleSelfHostedRelease({
    payloadRoot: fixture.payload,
    outputRoot: fixture.output,
    releaseId: '2026.09.03-test.4',
    releaseSequence: 5,
    target: { platform: 'darwin', architecture: 'arm64' },
    privateKey: keys.privateKey,
    keyId: 'fixture-key',
    createArchive: false,
  }), /private.*key|signing.*material/i)
})
