import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assembleSelfHostedRelease } from '../build-self-hosted-release.mjs'
import { verifyReleaseInventory, verifyReleaseManifest } from '../../deploy/self-hosted/runtime/release-contract.mjs'

const requiredFiles = [
  'runtime/node/bin/node',
  'app/web/server.js',
  'services/agent-host/dist/src/main.js',
  'services/browser-host/dist/src/main.js',
  'services/knowledge-service/dist/src/main.js',
  'orchestration/backend/docker/docker-compose.yml',
  'orchestration/services/zero/docker-compose.standalone.yml',
  'orchestration/docker-compose.production.yml',
  'images/runtime/manifest.json',
  'images/zokerbase/manifest.json',
  'images/zero/manifest.json',
  'toolchain/bin/podman',
  'project-vm/manifest.json',
  'project-vm/openlink-project-vm-base-arm64.raw',
  'openlinkctl.mjs',
  'bin/openlinkctl',
]

async function payloadFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openlink-release-build-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const payload = join(root, 'payload')
  const output = join(root, 'output')
  for (const relative of requiredFiles) {
    const path = join(payload, ...relative.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${relative}\n`, { mode: relative.includes('/bin/') || relative === 'bin/openlinkctl' ? 0o755 : 0o644 })
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
    target: { platform: 'darwin', architecture: 'arm64' },
    privateKey: keys.privateKey,
    keyId: 'fixture-key',
    createArchive: false,
  }), /missing.*app\/web\/server\.js/i)
})

test('refuses private signing material inside a customer payload', async (t) => {
  const fixture = await payloadFixture(t)
  const keys = generateKeyPairSync('ed25519')
  await writeFile(join(fixture.payload, 'release-signing-private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await assert.rejects(assembleSelfHostedRelease({
    payloadRoot: fixture.payload,
    outputRoot: fixture.output,
    releaseId: '2026.09.03-test.4',
    target: { platform: 'darwin', architecture: 'arm64' },
    privateKey: keys.privateKey,
    keyId: 'fixture-key',
    createArchive: false,
  }), /private.*key|signing.*material/i)
})
