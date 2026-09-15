#!/usr/bin/env node
/**
 * Produce OpenLink-owned Zero Standalone images and docker-save archives.
 * Upstream images are build inputs only. Runtime compose references only the
 * zokerbase/* tags and uses --pull never.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ensureDockerEngine } from './lib/docker-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const artifactRoot = resolve(root, '.openlink-runtime/knowledge/images')
const manifestPath = resolve(artifactRoot, 'manifest.json')
const version = process.env.OPENLINK_ZERO_IMAGE_VERSION || '3.0.0'
const allowAcquisition = process.env.OPENLINK_ZERO_ALLOW_UPSTREAM_ACQUISITION === '1'
const force = process.argv.includes('--force')
const skipArchives = process.env.OPENLINK_SKIP_IMAGE_ARCHIVES === '1'
const docker = await ensureDockerEngine()
// The runtime is built from an OpenLink-owned, locally cached Zero build
// input.  A source image may be supplied explicitly for image production;
// runtime startup never uses this value and never pulls it.
const localBuildInput = process.env.OPENLINK_ZERO_BUILD_INPUT_IMAGE || `zokerbase/zero-base:${version}`
// Keep the controlled acquisition input aligned with the vendored standalone
// deployment contract. Runtime startup still cannot pull: acquisition must be
// enabled explicitly by the image-production command.
const upstreamBuildInput = process.env.OPENLINK_ZERO_UPSTREAM_IMAGE || 'milvusdb/milvus:v3.0.0'
const specs = [
  // The source tag is a build-time input only. It is intentionally omitted
  // from the artifact manifest and never referenced by runtime compose.
  { name: 'zero', source: localBuildInput, upstream: upstreamBuildInput, target: `zokerbase/zero:${version}` },
  { name: 'etcd', source: 'quay.io/coreos/etcd:v3.5.25', target: 'zokerbase/zero-etcd:v3.5.25' },
  { name: 'minio', source: 'minio/minio:RELEASE.2024-05-28T17-19-04Z', target: 'zokerbase/zero-minio:RELEASE.2024-05-28T17-19-04Z' },
]

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    if (options.input !== undefined) child.stdin.end(options.input)
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.slice(-2_000)}`)))
  })
}

async function exists(path) {
  try { return (await stat(path)).isFile() && (await stat(path)).size > 1_024 } catch { return false }
}
async function imageExists(reference) { try { await run(docker, ['image', 'inspect', reference]); return true } catch { return false } }
async function ensureSource(spec) {
  if (await imageExists(spec.source)) return
  if (!allowAcquisition || !spec.upstream) throw new Error(`Missing local ZOKERBASE Zero build input ${spec.source}. Import the OpenLink Zero build artifact or provide OPENLINK_ZERO_UPSTREAM_IMAGE only while producing a new image.`)
  await run(docker, ['pull', spec.upstream])
  await run(docker, ['tag', spec.upstream, spec.source])
}
async function build(spec) {
  if (!force && await imageExists(spec.target)) return
  await ensureSource(spec)
  const dockerfile = spec.name === 'zero'
    ? `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nCOPY --chmod=0755 zero-entrypoint.sh /usr/local/bin/zero\nLABEL org.opencontainers.image.title="ZOKERBASE Zero"\nLABEL org.opencontainers.image.version="${version}"\nLABEL org.opencontainers.image.vendor="OpenLink"\nLABEL io.openlink.zero.build-input="vendored-vector-runtime"\n`
    : `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nLABEL org.opencontainers.image.title="ZOKERBASE ${spec.name}"\nLABEL org.opencontainers.image.vendor="OpenLink"\n`
  const buildContext = spec.name === 'zero' ? resolve(root, 'services/zero/openlink') : root
  await run(docker, ['build', '--pull=false', '--file', '-', '--tag', spec.target, '--build-arg', `BASE_IMAGE=${spec.source}`, buildContext], { input: dockerfile })
}
async function archive(spec) {
  const path = resolve(artifactRoot, `${spec.name}.tar`)
  if (!force && await exists(path)) return path
  const temporary = `${path}.${process.pid}.tmp`
  await run(docker, ['save', '--output', temporary, spec.target])
  await rename(temporary, path)
  return path
}

await run(docker, ['info', '--format', 'json'])
await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
const compose = await readFile(resolve(root, 'services/zero/openlink/docker-compose.standalone.yml'))
const fingerprint = createHash('sha256').update(compose).update(JSON.stringify(specs)).digest('hex')
const images = []
for (const spec of specs) {
  await build(spec)
  if (!skipArchives) await archive(spec)
  images.push({ image: spec.target, archive: `${spec.name}.tar` })
}
if (!skipArchives) {
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, product: 'ZOKERBASE', component: 'zero', version, fingerprint, createdAt: new Date().toISOString(), images }, null, 2)}\n`, { mode: 0o600 })
}
process.stdout.write(skipArchives ? 'ZOKERBASE Zero runtime images ready\n' : `ZOKERBASE Zero image artifact ready: ${artifactRoot}\n`)
