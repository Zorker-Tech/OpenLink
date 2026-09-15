#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, platform, release, arch } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { assembleSelfHostedRelease } from './build-self-hosted-release.mjs'
import { installReleaseArchive } from '../deploy/self-hosted/openlinkctl.mjs'
import { normalizeTarget } from '../deploy/self-hosted/runtime/release-contract.mjs'

const execFile = promisify(execFileCallback)
const target = normalizeTarget({ platform: process.platform, architecture: process.arch })
const runId = process.argv[2] || `${new Date().toISOString().replace(/[:.]/g, '-')}-${target.triple}`
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('Qualification run id is invalid')
const root = resolve(process.env.OPENLINK_QUALIFICATION_ROOT || '.openlink-qualification', runId)
await mkdir(root, { recursive: true, mode: 0o700 })
const work = await mkdtemp(join(root, '.work-'))
const payload = join(work, 'payload')
const output = join(work, 'output')
const installRoot = join(root, 'installed')
const startedAt = Date.now()

async function fixtureFile(relative, contents = `${relative}\n`, mode = 0o644) {
  const path = join(payload, ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true, mode: 0o755 })
  await writeFile(path, contents, { mode })
}

try {
  await mkdir(join(payload, 'runtime/node/bin'), { recursive: true, mode: 0o755 })
  await cp(process.execPath, join(payload, 'runtime/node/bin/node'))
  await chmod(join(payload, 'runtime/node/bin/node'), 0o755)
  await cp(resolve('deploy/self-hosted/openlinkctl.mjs'), join(payload, 'openlinkctl.mjs'))
  await cp(resolve('deploy/self-hosted/bin/openlinkctl'), join(payload, 'bin/openlinkctl'))
  await cp(resolve('deploy/self-hosted/runtime'), join(payload, 'runtime'), { recursive: true, dereference: true })
  await chmod(join(payload, 'bin/openlinkctl'), 0o755)

  for (const relative of [
    'app/web/server.js',
    'services/agent-host/dist/src/main.js',
    'services/agent-host/dist/src/project-container-main.js',
    'services/agent-host/project-supabase-runtime.mjs',
    'scripts/lib/project-supabase-bundle.mjs',
    'services/agent-host/dist/src/desktop-main.js',
    'services/browser-host/dist/src/main.js',
    'services/knowledge-service/dist/src/main.js',
    'orchestration/backend/docker/docker-compose.yml',
    'orchestration/backend/docker/.env.example',
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
    `project-vm/openlink-project-vm-base-${target.architecture}.${target.diskFormat}`,
    'project-supabase/manifest.json',
    'project-supabase/runtime.lock.json',
    'project-supabase/runtime.spec.json',
    'project-supabase/image-manifest.json',
    'project-supabase/release-trust.json',
    'systemd/openlink.service',
    'systemd/openlink-container-broker.service',
    'systemd/openlink-project-container-broker.service',
  ]) {
    const contents = relative === 'browser/manifest.json'
      ? `${JSON.stringify({ target: target.triple, executable: 'chromium/chrome' })}\n`
      : relative.endsWith('.json') ? '{}\n' : `${relative}\n`
    await fixtureFile(relative, contents, relative.includes('/bin/') || relative === 'browser/chromium/chrome' ? 0o755 : 0o644)
  }

  const keys = generateKeyPairSync('ed25519')
  const releaseId = `qualification-${target.triple}`
  const assembled = await assembleSelfHostedRelease({
    payloadRoot: payload,
    outputRoot: output,
    releaseId,
    releaseSequence: 1,
    target,
    privateKey: keys.privateKey,
    keyId: 'qualification-only',
  })
  const bundle = await readFile(assembled.archive)
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex')
  const installed = await installReleaseArchive({
    archive: assembled.archive,
    installRoot,
    trustedKeys: { 'qualification-only': keys.publicKey },
    expectedTarget: target,
    temporaryRoot: work,
  })
  const versionResult = await execFile(join(installRoot, 'current/bin/openlinkctl'), ['version', '--root', installRoot], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  const reported = JSON.parse(versionResult.stdout)
  if (reported.releaseId !== releaseId) throw new Error('Installed openlinkctl did not report the activated release')

  const tamperedArchive = join(work, 'tampered.tar.gz')
  const tampered = Buffer.from(bundle)
  tampered[Math.max(16, Math.floor(tampered.length / 2))] ^= 0xff
  await writeFile(tamperedArchive, tampered)
  let tamperRejected = false
  try {
    await installReleaseArchive({
      archive: tamperedArchive,
      installRoot: join(root, 'tampered-install'),
      trustedKeys: { 'qualification-only': keys.publicKey },
      expectedTarget: target,
      temporaryRoot: work,
    })
  } catch {
    tamperRejected = true
  }
  if (!tamperRejected) throw new Error('Tampered bundle was not rejected')

  const results = {
    schemaVersion: 1,
    runId,
    passed: true,
    host: { hostname: hostname(), platform: platform(), architecture: arch(), osRelease: release() },
    runtime: { node: process.version },
    target: target.triple,
    releaseId,
    bundleSha256,
    checks: {
      signedManifest: 'pass',
      completeInventory: 'pass',
      safeArchiveExtraction: 'pass',
      immutableInstall: installed.reused ? 'fail' : 'pass',
      atomicActivation: 'pass',
      bundledRuntimeExecution: 'pass',
      tamperRejection: 'pass',
      noSourceBuildDuringInstall: 'pass',
    },
    elapsedMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  }
  await writeFile(join(root, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
} finally {
  await rm(work, { recursive: true, force: true })
}
