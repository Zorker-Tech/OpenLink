import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { deploymentStatus, inspectApplicationHealth, installReleaseArchive, installReleaseDirectory, nativeServiceStatus, readServiceLogs, serviceAction, waitForApplicationHealth } from '../../deploy/self-hosted/openlinkctl.mjs'
import {
  createReleaseInventory,
  normalizeTarget,
  signReleaseManifest,
} from '../../deploy/self-hosted/runtime/release-contract.mjs'
import { extractVerifiedTarGzip, parseTarNumber } from '../../deploy/self-hosted/runtime/safe-archive.mjs'

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

test('safe archive extractor enforces a cumulative expansion limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-archive-limit-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const archive = join(root, 'payload.tar.gz')
  await mkdir(source)
  await writeFile(join(source, 'one'), '12345678')
  await writeFile(join(source, 'two'), '12345678')
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-czf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`tar exited ${code}`)))
  })
  await assert.rejects(extractVerifiedTarGzip(archive, join(root, 'output'), { maximumTotalBytes: 12 }), /expands beyond/i)
  await assert.rejects(lstat(join(root, 'output')), /ENOENT/)
})

test('safe archive extractor rejects oversized compressed input before decompression', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-archive-compressed-limit-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const archive = join(root, 'oversized.tar.gz')
  const handle = await (await import('node:fs/promises')).open(archive, 'w')
  await handle.truncate(4097)
  await handle.close()
  await assert.rejects(extractVerifiedTarGzip(archive, join(root, 'output'), { maximumArchiveBytes: 4096 }), /compressed size exceeds/i)
  await assert.rejects(lstat(join(root, 'output')), /ENOENT/)
})

test('safe archive extractor preserves an operator-defined disk reserve', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-archive-disk-reserve-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const archive = join(root, 'payload.tar.gz')
  await mkdir(source)
  await writeFile(join(source, 'payload'), 'reserved')
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-czf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`tar exited ${code}`)))
  })
  await assert.rejects(extractVerifiedTarGzip(archive, join(root, 'output'), {
    minimumFreeBytesAfterExtraction: Number.MAX_SAFE_INTEGER,
  }), /free-space reserve/i)
  await assert.rejects(lstat(join(root, 'output')), /ENOENT/)
})

test('safe archive extractor bounds all headers before signature verification', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-archive-entries-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const archive = join(root, 'payload.tar.gz')
  await mkdir(source)
  await writeFile(join(source, 'one'), '')
  await writeFile(join(source, 'two'), '')
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-czf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`tar exited ${code}`)))
  })
  await assert.rejects(extractVerifiedTarGzip(archive, join(root, 'output'), { maximumEntries: 2 }), /more than 2 entries/i)
  await assert.rejects(lstat(join(root, 'output')), /ENOENT/)
})

test('safe archive extractor rejects setuid, setgid and sticky permission bits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-archive-special-mode-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const archive = join(root, 'payload.tar.gz')
  await mkdir(source)
  await writeFile(join(source, 'privileged'), '#!/bin/sh\n')
  await chmod(join(source, 'privileged'), 0o4755)
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-czf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`tar exited ${code}`)))
  })
  await assert.rejects(extractVerifiedTarGzip(archive, join(root, 'output')), /special permission bits/i)
  await assert.rejects(lstat(join(root, 'output')), /ENOENT/)
})

test('application health requires the expected release identity', async (t) => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, releaseId: requests === 1 ? 'old-release' : 'new-release' }))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)))
  const address = server.address()
  await waitForApplicationHealth(`http://127.0.0.1:${address.port}`, 'new-release', 5_000)
  assert.equal(requests, 2)
})

test('one-shot health inspection rejects mismatched and oversized responses', async () => {
  await assert.rejects(inspectApplicationHealth('https://openlink.invalid', 'release-b', {
    fetch: async () => new Response(JSON.stringify({ ok: true, releaseId: 'release-a' }), { status: 200 }),
  }), /expected release-b/i)
  await assert.rejects(inspectApplicationHealth('https://openlink.invalid', 'release-a', {
    maximumBytes: 16,
    fetch: async () => new Response(JSON.stringify({ ok: true, releaseId: 'release-a' }), { status: 200 }),
  }), /too large/i)
})

test('Linux service operations are root-only, ordered, and report both units', async () => {
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, args])
    if (args[0] === 'show') return { stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\n' }
    return { stdout: '' }
  }
  await assert.rejects(serviceAction('start', '/var/lib/openlink', { platform: 'linux', getuid: () => 1000, execFile: runner }), /must run as root/i)
  await serviceAction('stop', '/var/lib/openlink', { platform: 'linux', getuid: () => 0, execFile: runner })
  assert.deepEqual(calls.at(-1)[1], ['stop', 'openlink.service', 'openlink-container-broker.service'])
  const status = await nativeServiceStatus({ platform: 'linux', execFile: runner })
  assert.equal(status.active, true)
  assert.equal(status.service.MainPID, '42')
  assert.equal(calls.filter(([, args]) => args[0] === 'show').length, 2)
})

test('Linux Container lifecycle reconciles and orders the isolated Project broker', async () => {
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, args])
    if (args[0] === 'show') return { stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\n' }
    return { stdout: '' }
  }
  const options = { platform: 'linux', getuid: () => 0, execFile: runner, projectRuntime: 'container', reconcileProjectBroker: true }
  await serviceAction('start', '/var/lib/openlink', options)
  assert.deepEqual(calls[0][1], ['enable', 'openlink-project-container-broker.service'])
  assert.deepEqual(calls[1][1], ['start', 'openlink-container-broker.service', 'openlink-project-container-broker.service', 'openlink.service'])
  calls.length = 0
  await serviceAction('stop', '/var/lib/openlink', options)
  assert.deepEqual(calls[0][1], ['stop', 'openlink.service', 'openlink-project-container-broker.service', 'openlink-container-broker.service'])
  calls.length = 0
  const status = await nativeServiceStatus({ platform: 'linux', execFile: runner, projectRuntime: 'container' })
  assert.equal(status.active, true)
  assert.equal(status.projectBroker.MainPID, '42')
  assert.equal(calls.length, 3)
})

test('operator status exposes profile and backend without conflating Core with Container', () => {
  assert.deepEqual(deploymentStatus({
    OPENLINK_DEPLOYMENT_PROFILE: 'core', OPENLINK_DEPLOYMENT_PROFILE_REVISION: 'core/v1',
    OPENLINK_PROJECT_RUNTIME: 'vm', OPENLINK_PROJECT_ISOLATION: 'vm',
    OPENLINK_KNOWLEDGE_ENABLED: '0', OPENLINK_ZERO_ENABLED: '0',
  }), { profile: 'core', profileRevision: 'core/v1', projectRuntime: 'vm', isolation: 'vm', knowledge: false, zero: false })
  assert.equal(deploymentStatus({ OPENLINK_DEPLOYMENT_PROFILE: 'dense', OPENLINK_PROJECT_RUNTIME: 'container', OPENLINK_PROJECT_ISOLATION: 'container' }).profile, 'dense')
})

test('service logs use bounded fixed argv', async () => {
  const calls = []
  const output = await readServiceLogs({ platform: 'linux', lines: 250, execFile: async (command, args) => { calls.push([command, args]); return { stdout: 'journal\n' } } })
  assert.equal(output, 'journal\n')
  assert.deepEqual(calls[0][0], 'journalctl')
  assert.equal(calls[0][1].includes('--lines=250'), true)
  await assert.rejects(readServiceLogs({ platform: 'linux', lines: 5001, execFile: async () => '' }), /between 1 and 5000/i)
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
    releaseSequence: 1,
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
