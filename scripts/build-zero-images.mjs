#!/usr/bin/env node
/**
 * Produce OpenLink-owned Zero Standalone images and docker-save archives.
 * Upstream images are build inputs only. Runtime compose references only the
 * zokerbase/* tags and uses --pull never.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ensureDockerEngine } from './lib/docker-runtime.mjs'
import { localRuntimeCacheRoot } from './lib/local-runtime-cache.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const artifactRoot = resolve(root, '.openlink-runtime/knowledge/images')
const manifestPath = resolve(artifactRoot, 'manifest.json')
const version = process.env.OPENLINK_ZERO_IMAGE_VERSION || '3.0.0'
const allowAcquisition = process.env.OPENLINK_ZERO_ALLOW_UPSTREAM_ACQUISITION === '1'
const force = process.argv.includes('--force')
const skipArchives = process.env.OPENLINK_SKIP_IMAGE_ARCHIVES === '1'
const docker = await ensureDockerEngine()
const nativeArchitecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined
if (!nativeArchitecture) throw new Error(`Unsupported Zero image architecture ${process.arch}`)
const platform = process.env.OPENLINK_IMAGE_PLATFORM?.trim() || process.env.DOCKER_DEFAULT_PLATFORM?.trim() || `linux/${nativeArchitecture}`
if (!/^linux\/(amd64|arm64)$/.test(platform)) throw new Error('OPENLINK_IMAGE_PLATFORM must be linux/amd64 or linux/arm64')
const platformArchitecture = platform.slice('linux/'.length)
const requestedBuildNetwork = process.env.OPENLINK_IMAGE_BUILD_NETWORK?.trim()
const imageBuildNetwork = requestedBuildNetwork || (process.platform === 'linux' ? 'host' : '')
if (imageBuildNetwork && !['default', 'host', 'none'].includes(imageBuildNetwork)) {
  throw new Error('OPENLINK_IMAGE_BUILD_NETWORK must be default, host, or none')
}
const minioRelease = 'RELEASE.2024-05-28T17-19-04Z'
const minioCacheRoot = resolve(localRuntimeCacheRoot(), 'minio')
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
async function minioReleaseBinary() {
  if (!allowAcquisition) throw new Error('Missing local MinIO release asset. Enable OPENLINK_ZERO_ALLOW_UPSTREAM_ACQUISITION=1 to obtain the pinned official release.')
  await mkdir(minioCacheRoot, { recursive: true, mode: 0o700 })
  const asset = `minio.${platform.replace('/', '-')}.${minioRelease}`
  const assetPath = resolve(minioCacheRoot, asset)
  const checksumPath = `${assetPath}.sha256sum`
  const releaseUrl = `https://github.com/minio/minio/releases/download/${minioRelease}`
  if (!(await exists(assetPath))) {
    const temporary = `${assetPath}.${process.pid}.tmp`
    await run('curl', ['--fail', '--location', '--retry', '3', '--output', temporary, `${releaseUrl}/${asset}`])
    await rename(temporary, assetPath)
  }
  let checksum
  try { checksum = await readFile(checksumPath, 'utf8') } catch {
    await run('curl', ['--fail', '--location', '--retry', '3', '--output', checksumPath, `${releaseUrl}/${asset}.sha256sum`])
    checksum = await readFile(checksumPath, 'utf8')
  }
  const expected = checksum.trim().split(/\s+/)[0]?.toLowerCase()
  const actual = createHash('sha256').update(await readFile(assetPath)).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(expected || '') || actual !== expected) {
    throw new Error(`Pinned MinIO ${platformArchitecture} release checksum does not match its official SHA-256 file`)
  }
  return assetPath
}
async function buildMinio(spec) {
  const releaseBinary = await minioReleaseBinary()
  const temporaryRoot = resolve(localRuntimeCacheRoot(), 'tmp')
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  const buildContext = await mkdtemp(resolve(temporaryRoot, 'zero-minio-'))
  try {
    await copyFile(releaseBinary, resolve(buildContext, 'minio'))
    await copyFile(resolve(root, 'services/zero/openlink/minio-entrypoint.sh'), resolve(buildContext, 'minio-entrypoint.sh'))
    const dockerfile = [
      'FROM debian:bookworm-slim',
      'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*',
      'COPY --chmod=0755 minio /usr/local/bin/minio',
      'COPY --chmod=0755 minio-entrypoint.sh /usr/local/bin/minio-entrypoint.sh',
      'ENTRYPOINT ["/usr/local/bin/minio-entrypoint.sh"]',
      'LABEL org.opencontainers.image.title="ZOKERBASE Zero MinIO"',
      `LABEL org.opencontainers.image.version="${minioRelease}"`,
      'LABEL org.opencontainers.image.vendor="OpenLink"',
      `LABEL io.openlink.zero.build-input="github.com/minio/minio@${minioRelease}"`,
      '',
    ].join('\n')
    const args = ['build', '--pull=false', '--platform', platform]
    if (imageBuildNetwork) args.push('--network', imageBuildNetwork)
    args.push('--file', '-', '--tag', spec.target, buildContext)
    await run(docker, args, { input: dockerfile })
  } finally {
    await rm(buildContext, { recursive: true, force: true })
  }
}
async function ensureSource(spec) {
  if (await imageExists(spec.source)) return
  if (!allowAcquisition || !spec.upstream) throw new Error(`Missing local ZOKERBASE Zero build input ${spec.source}. Import the OpenLink Zero build artifact or provide OPENLINK_ZERO_UPSTREAM_IMAGE only while producing a new image.`)
  await run(docker, ['pull', '--platform', platform, spec.upstream])
  await run(docker, ['tag', spec.upstream, spec.source])
}
async function build(spec) {
  if (!force && await imageExists(spec.target)) return
  if (spec.name === 'minio') {
    await buildMinio(spec)
    return
  }
  await ensureSource(spec)
  const dockerfile = spec.name === 'zero'
    ? `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nCOPY --chmod=0755 zero-entrypoint.sh /usr/local/bin/zero\nLABEL org.opencontainers.image.title="ZOKERBASE Zero"\nLABEL org.opencontainers.image.version="${version}"\nLABEL org.opencontainers.image.vendor="OpenLink"\nLABEL io.openlink.zero.build-input="vendored-vector-runtime"\n`
    : `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nLABEL org.opencontainers.image.title="ZOKERBASE ${spec.name}"\nLABEL org.opencontainers.image.vendor="OpenLink"\n`
  const buildContext = spec.name === 'zero' ? resolve(root, 'services/zero/openlink') : root
  const args = ['build', '--pull=false', '--platform', platform]
  if (imageBuildNetwork) args.push('--network', imageBuildNetwork)
  args.push('--file', '-', '--tag', spec.target, '--build-arg', `BASE_IMAGE=${spec.source}`, buildContext)
  await run(docker, args, { input: dockerfile })
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
