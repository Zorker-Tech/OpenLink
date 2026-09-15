#!/usr/bin/env node
/**
 * Produce OpenLink-owned ZOKERBASE runtime images.
 *
 * Docker Compose only consumes zokerbase/* references.  Upstream images are
 * used strictly as pinned build inputs when an artifact is produced; they are
 * never resolved while ZOKERBASE is running.  `docker save` archives make a
 * release or air-gapped installation independent from an image registry.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ensureDockerEngine } from './lib/docker-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const backendRoot = resolve(root, 'backend')
const artifactRoot = resolve(root, '.openlink-runtime/zokerbase/images')
const manifestPath = resolve(artifactRoot, 'manifest.json')
const version = process.env.ZOKERBASE_IMAGE_VERSION || '2026.08.10'
const allowAcquisition = process.env.OPENLINK_ZOKERBASE_ALLOW_UPSTREAM_ACQUISITION !== '0'
const force = process.argv.includes('--force')
const skipArchives = process.env.OPENLINK_SKIP_IMAGE_ARCHIVES === '1'
const docker = await ensureDockerEngine()

const specs = [
  ['studio', 'supabase/studio:2026.08.03-sha-022b374'],
  ['gateway', 'kong/kong:3.9.3'],
  ['auth', 'supabase/gotrue:v2.189.0'],
  ['rest', 'postgrest/postgrest:v14.12'],
  ['realtime', 'supabase/realtime:v2.102.3'],
  ['storage', 'supabase/storage-api:v1.60.4'],
  ['imgproxy', 'darthsim/imgproxy:v3.30.1'],
  ['postgres-meta', 'supabase/postgres-meta:v0.96.6'],
  ['edge-runtime', 'supabase/edge-runtime:v1.74.0'],
  ['postgres', 'supabase/postgres:17.6.1.136'],
  ['supavisor', 'supabase/supavisor:2.9.5'],
].map(([name, source]) => ({ name, source, target: `zokerbase/${name}:${version}` }))

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...options.env },
      stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    if (options.input !== undefined) child.stdin.end(options.input)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveRun(stdout.trim())
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.trim().slice(-2000)}`))
    })
  })
}

async function imageExists(reference) {
  try {
    await run(docker, ['image', 'inspect', reference])
    return true
  } catch {
    return false
  }
}

async function exists(path) {
  try {
    return (await stat(path)).isFile() && (await stat(path)).size > 1024
  } catch {
    return false
  }
}

async function sourceFingerprint() {
  const compose = await readFile(resolve(backendRoot, 'docker/docker-compose.yml'))
  const overlay = await readFile(resolve(backendRoot, 'docker/docker-compose.zokerbase.yml'))
  return createHash('sha256').update(compose).update(overlay).update(JSON.stringify(specs)).digest('hex')
}

async function ensureSource(spec) {
  if (await imageExists(spec.source)) return
  if (!allowAcquisition) {
    throw new Error(`Missing ZOKERBASE build input ${spec.source}. Import the published ZOKERBASE artifact or run image production with OPENLINK_ZOKERBASE_ALLOW_UPSTREAM_ACQUISITION=1.`)
  }
  await run(docker, ['pull', spec.source])
}

async function build(spec) {
  if (!force && await imageExists(spec.target)) return
  await ensureSource(spec)
  // The tiny wrapper creates a product-owned image manifest and labels its
  // provenance. --pull=false guarantees that a service start cannot silently
  // contact an upstream registry after the build input is locally available.
  const dockerfile = [
    'ARG BASE_IMAGE',
    'FROM ${BASE_IMAGE}',
    'LABEL org.opencontainers.image.title="ZOKERBASE"',
    `LABEL org.opencontainers.image.version="${version}"`,
    `LABEL io.openlink.zokerbase.component="${spec.name}"`,
    `LABEL io.openlink.zokerbase.build-input="${spec.source}"`,
    '',
  ].join('\n')
  await run(docker, [
    'build', '--pull=false', '--file', '-', '--tag', spec.target,
    '--build-arg', `BASE_IMAGE=${spec.source}`, '.',
  ], { cwd: backendRoot, input: dockerfile })
}

async function writeArtifact(spec) {
  const archive = resolve(artifactRoot, `${spec.name}.tar`)
  if (!force && await exists(archive)) return archive
  const temporary = `${archive}.${process.pid}.tmp`
  await run(docker, ['save', '--output', temporary, spec.target])
  await rename(temporary, archive)
  return archive
}

async function main() {
  await run(docker, ['info', '--format', 'json'])
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  const fingerprint = await sourceFingerprint()
  const images = []
  for (const spec of specs) {
    await build(spec)
    if (!skipArchives) await writeArtifact(spec)
    images.push({ name: spec.name, image: spec.target, archive: `${spec.name}.tar`, source: spec.source })
  }
  const manifest = {
    schemaVersion: 1,
    product: 'ZOKERBASE',
    version,
    fingerprint,
    createdAt: new Date().toISOString(),
    images,
  }
  if (!skipArchives) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(skipArchives ? 'ZOKERBASE runtime images ready\n' : `ZOKERBASE image artifact ready: ${artifactRoot}\n`)
}

await main()
