import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { buildSelfHostedInstaller } from '../build-self-hosted-installer.mjs'
import { assembleSelfHostedRelease } from '../build-self-hosted-release.mjs'

const execFile = promisify(execFileCallback)

test('builds a native sealed installer that runs without a source tree or system Node lookup', { timeout: 240_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-installer-sea-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  const trustFile = join(root, 'release-keys.json')
  await writeFile(trustFile, `${JSON.stringify({ keys: { 'qualification-key': { publicKeyPem: publicKey } } }, null, 2)}\n`, { mode: 0o644 })
  await chmod(trustFile, 0o644)
  const output = join(root, 'build/openlink-installer')
  const built = await buildSelfHostedInstaller({ output, trustFile, nodeExecutable: process.execPath })
  assert.ok(built.bytes > 10 * 1024 * 1024)
  const isolated = join(root, 'isolated/openlink-installer')
  await mkdir(join(isolated, '..'), { recursive: true })
  await (await import('node:fs/promises')).copyFile(output, isolated)
  await chmod(isolated, 0o755)
  const { stdout } = await execFile(isolated, ['--self-test'], { cwd: join(root, 'isolated'), env: { PATH: '/usr/bin:/bin' }, timeout: 30_000 })
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.sealedInstaller, true)
  assert.deepEqual(result.trustedKeyIds, ['qualification-key'])
})

test('sealed installer performs signed archive install and protected configuration without build tools', { timeout: 240_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-installer-e2e-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const trustFile = join(root, 'release-keys.json')
  await writeFile(trustFile, `${JSON.stringify({ keys: { 'e2e-key': { publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) } } }, null, 2)}\n`, { mode: 0o644 })
  await chmod(trustFile, 0o644)
  const payload = join(root, 'payload')
  const target = process.platform === 'darwin'
    ? { platform: 'darwin', architecture: 'arm64' }
    : { platform: 'linux', architecture: process.arch }
  const targetArchitecture = process.platform === 'linux' && process.arch === 'x64' ? 'amd64' : process.arch
  const diskFormat = process.platform === 'darwin' ? 'raw' : 'qcow2'
  const required = [
    'runtime/node/bin/node', 'app/web/server.js', 'services/agent-host/dist/src/main.js',
    'services/browser-host/dist/src/main.js', 'services/knowledge-service/dist/src/main.js',
    'orchestration/backend/docker/docker-compose.yml', 'orchestration/backend/docker/.env.example',
    'orchestration/services/zero/docker-compose.standalone.yml', 'orchestration/docker-compose.production.yml',
    'orchestration/docker-compose.zero-production.yml', 'images/runtime/manifest.json', 'images/zokerbase/manifest.json',
    'images/zero/manifest.json', 'toolchain/bin/podman', 'project-vm/manifest.json',
    `project-vm/openlink-project-vm-base-${targetArchitecture}.${diskFormat}`, 'openlinkctl.mjs', 'bin/openlinkctl',
  ]
  for (const relative of required) {
    const path = join(payload, ...relative.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    const contents = relative.endsWith('.env.example')
      ? 'POSTGRES_PASSWORD=insecure\nJWT_SECRET=insecure\nANON_KEY=insecure\nSERVICE_ROLE_KEY=insecure\n'
      : relative.endsWith('project-vm/manifest.json') ? `${JSON.stringify({ disk: `openlink-project-vm-base-${targetArchitecture}.${diskFormat}` })}\n`
        : relative.endsWith('.json') ? '{}\n' : `${relative}\n`
    await writeFile(path, contents, { mode: relative.includes('/bin/') || relative === 'bin/openlinkctl' ? 0o755 : 0o644 })
  }
  const release = await assembleSelfHostedRelease({ payloadRoot: payload, outputRoot: join(root, 'releases'), releaseId: 'sea-e2e-1', target, privateKey: keys.privateKey, keyId: 'e2e-key' })
  const installer = join(root, 'openlink-installer')
  await buildSelfHostedInstaller({ output: installer, trustFile, nodeExecutable: process.execPath })
  const installRoot = join(root, 'installed')
  const configPath = join(root, 'configuration/openlink.env')
  const { stdout, stderr } = await execFile(installer, [
    '--archive', release.archive, '--app-url', 'http://127.0.0.1:7443', '--allow-insecure-http', '1',
    '--root', installRoot, '--config', configPath, '--state-root', join(root, 'state'), '--skip-host-preflight', '1',
  ], { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 })
  assert.equal(stderr, '')
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.installed.releaseId, 'sea-e2e-1')
  assert.match(await readFile(configPath, 'utf8'), /OPENLINK_APP_URL=http:\/\/127\.0\.0\.1:7443/)
  assert.equal((await readFile(join(root, 'configuration/secrets.env'), 'utf8')).includes('insecure'), false)
})
