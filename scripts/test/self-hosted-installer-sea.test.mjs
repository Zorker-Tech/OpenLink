import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { generateKeyPairSync, verify } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const trustFile = join(root, 'release-keys.json')
  await writeFile(trustFile, `${JSON.stringify({ schemaVersion: 1, minimumReleaseSequence: 1, keys: { 'qualification-key': { algorithm: 'Ed25519', status: 'active', publicKeyPem: publicKey } } }, null, 2)}\n`, { mode: 0o644 })
  await chmod(trustFile, 0o644)
  const output = join(root, 'build/openlink-installer')
  const built = await buildSelfHostedInstaller({ output, trustFile, nodeExecutable: process.execPath, signingKey: keys.privateKey, keyId: 'qualification-key' })
  assert.ok(built.bytes > 10 * 1024 * 1024)
  assert.equal(verify(null, await readFile(built.checksumPath), keys.publicKey, await readFile(built.signaturePath)), true)
  assert.match(await readFile(built.checksumPath, 'utf8'), new RegExp(`^${built.sha256}  openlink-installer\\n$`))
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
  await writeFile(trustFile, `${JSON.stringify({ schemaVersion: 1, minimumReleaseSequence: 1, keys: { 'e2e-key': { algorithm: 'Ed25519', status: 'active', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) } } }, null, 2)}\n`, { mode: 0o644 })
  await chmod(trustFile, 0o644)
  const payload = join(root, 'payload')
  const target = process.platform === 'darwin'
    ? { platform: 'darwin', architecture: 'arm64' }
    : { platform: 'linux', architecture: process.arch }
  const targetArchitecture = process.platform === 'linux' && process.arch === 'x64' ? 'amd64' : process.arch
  const diskFormat = process.platform === 'darwin' ? 'raw' : 'qcow2'
  const required = [
    'runtime/node/bin/node', 'app/web/server.js', 'services/agent-host/dist/src/main.js', 'services/agent-host/dist/src/project-container-main.js',
    'services/agent-host/project-supabase-runtime.mjs', 'scripts/lib/project-supabase-bundle.mjs',
    'services/browser-host/dist/src/main.js', 'services/knowledge-service/dist/src/main.js',
    'orchestration/backend/docker/docker-compose.yml', 'orchestration/backend/docker/.env.example',
    'orchestration/services/zero/docker-compose.standalone.yml', 'orchestration/docker-compose.production.yml',
    'orchestration/docker-compose.zero-production.yml', 'images/runtime/manifest.json', 'images/zokerbase/manifest.json',
    'images/zero/manifest.json', 'toolchain/bin/podman', 'edge/bin/caddy', 'edge/Caddyfile',
    'browser/manifest.json', 'browser/chromium/chrome', 'project-vm/manifest.json',
    'project-supabase/manifest.json', 'project-supabase/runtime.lock.json', 'project-supabase/runtime.spec.json', 'project-supabase/image-manifest.json', 'project-supabase/release-trust.json',
    'services/agent-host/dist/src/desktop-main.js',
    `project-vm/openlink-project-vm-base-${targetArchitecture}.${diskFormat}`, 'openlinkctl.mjs', 'bin/openlinkctl',
    'systemd/openlink.service',
    'systemd/openlink-container-broker.service',
    'systemd/openlink-project-container-broker.service',
  ]
  for (const relative of required) {
    const path = join(payload, ...relative.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    const contents = relative.endsWith('.env.example')
      ? 'POSTGRES_PASSWORD=insecure\nJWT_SECRET=insecure\nANON_KEY=insecure\nSERVICE_ROLE_KEY=insecure\n'
      : relative === 'browser/manifest.json' ? `${JSON.stringify({ target: `${target.platform}-${targetArchitecture}`, executable: 'chromium/chrome' })}\n`
      : relative.endsWith('project-vm/manifest.json') ? `${JSON.stringify({ disk: `openlink-project-vm-base-${targetArchitecture}.${diskFormat}` })}\n`
        : relative.endsWith('.json') ? '{}\n' : `${relative}\n`
    await writeFile(path, contents, { mode: relative.includes('/bin/') || relative === 'bin/openlinkctl' || relative === 'browser/chromium/chrome' ? 0o755 : 0o644 })
  }
  const release = await assembleSelfHostedRelease({ payloadRoot: payload, outputRoot: join(root, 'releases'), releaseId: 'sea-e2e-1', releaseSequence: 1, target, privateKey: keys.privateKey, keyId: 'e2e-key' })
  const installer = join(root, 'openlink-installer')
  await buildSelfHostedInstaller({ output: installer, trustFile, nodeExecutable: process.execPath, signingKey: keys.privateKey, keyId: 'e2e-key' })
  const installRoot = join(root, 'installed')
  const configPath = join(root, 'configuration/openlink.env')
  await assert.rejects(execFile(installer, [
    '--archive', release.archive, '--app-url', 'http://127.0.0.1:7443',
    '--root', installRoot, '--config', configPath, '--state-root', join(root, 'state'), '--skip-host-preflight', '1',
    '--skip-service-install', '1',
  ], { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 }), /must use HTTPS/i)
  await assert.rejects(lstat(join(installRoot, 'current')), /ENOENT/)
  await mkdir(join(root, 'configuration'), { recursive: true })
  await writeFile(join(root, 'configuration/release-keys.json'), await readFile(trustFile), { mode: 0o644 })
  const { stdout, stderr } = await execFile(installer, [
    '--archive', release.archive, '--app-url', 'http://127.0.0.1:7443', '--allow-insecure-http', '1',
    '--root', installRoot, '--config', configPath, '--state-root', join(root, 'state'), '--skip-host-preflight', '1',
    '--skip-service-install', '1',
  ], { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 })
  assert.equal(stderr, '')
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.installed.releaseId, 'sea-e2e-1')
  assert.equal(result.service.skipped, true)
  assert.match(await readFile(configPath, 'utf8'), /OPENLINK_APP_URL=http:\/\/127\.0\.0\.1:7443/)
  assert.match(await readFile(configPath, 'utf8'), /OPENLINK_RELEASE_TRUST_FILE=.*release-keys\.json/)
  const installedTrust = join(root, 'configuration/release-keys.json')
  assert.equal((await lstat(installedTrust)).mode & 0o777, 0o644)
  assert.equal(JSON.parse(await readFile(installedTrust, 'utf8')).keys['e2e-key'].status, 'active')
  const secretsBeforeRetry = await readFile(join(root, 'configuration/secrets.env'), 'utf8')
  assert.equal(secretsBeforeRetry.includes('insecure'), false)
  const retry = JSON.parse((await execFile(installer, [
    '--archive', release.archive, '--app-url', 'http://127.0.0.1:7443', '--allow-insecure-http', '1',
    '--root', installRoot, '--config', configPath, '--state-root', join(root, 'state'), '--skip-host-preflight', '1',
    '--skip-service-install', '1',
  ], { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 })).stdout)
  assert.equal(retry.installed.reused, true)
  assert.equal(retry.configuration.reused, true)
  assert.equal(await readFile(join(root, 'configuration/secrets.env'), 'utf8'), secretsBeforeRetry)
  await assert.rejects(execFile(installer, [
    '--archive', release.archive, '--app-url', 'http://127.0.0.1:7444', '--allow-insecure-http', '1',
    '--root', installRoot, '--config', configPath, '--state-root', join(root, 'state'), '--skip-host-preflight', '1',
    '--skip-service-install', '1',
  ], { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 }), /does not match/i)
  assert.equal(await readFile(join(root, 'configuration/secrets.env'), 'utf8'), secretsBeforeRetry)
  const replacement = await assembleSelfHostedRelease({ payloadRoot: payload, outputRoot: join(root, 'replacement'), releaseId: 'sea-e2e-2', releaseSequence: 2, target, privateKey: keys.privateKey, keyId: 'e2e-key' })
  await assert.rejects(execFile(installer, [
    '--archive', replacement.archive, '--app-url', 'http://127.0.0.1:7443', '--allow-insecure-http', '1',
    '--root', installRoot, '--config', configPath, '--state-root', join(root, 'state'), '--skip-host-preflight', '1',
    '--skip-service-install', '1',
  ], { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 }), /openlinkctl upgrade/i)
  assert.equal((await readFile(join(installRoot, 'current/release.json'), 'utf8')).includes('sea-e2e-1'), true)
})
