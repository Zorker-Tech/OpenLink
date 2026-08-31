import { createHash, randomBytes } from 'node:crypto'
import { access, appendFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'
import { ensurePodmanBuilder, run, stopPodmanBuilder } from './lib/podman-builder.mjs'
import { hashConfigurationTree, readProjectSupabaseLock } from './lib/project-supabase-lock.mjs'
import { nodeArchitecture } from './lib/project-supabase-images.mjs'
import { assertWindowsRuntimeDirectoryHyperVAccess } from './lib/windows-security.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
await configureBundledPodmanRuntime(root)
await assertWindowsRuntimeDirectoryHyperVAccess(resolve(root, '.openlink-runtime'))

const podman = process.env.OPENLINK_PODMAN_COMMAND || resolve(root, '.openlink-runtime/toolchain/bin/podman')
const containerfile = resolve(root, 'services/agent-host/project-vm-base.Containerfile')
const outputDirectory = resolve(root, '.openlink-runtime/project-vm-base')
const archive = resolve(outputDirectory, 'openlink-project-vm-base.oci.tar')
const manifestPath = resolve(outputDirectory, 'manifest.json')
const projectSupabaseLockPath = resolve(root, 'services/project-supabase/runtime.lock.json')
const projectSupabaseConfiguration = resolve(root, '.openlink-runtime/project-supabase/configuration')
const projectSupabaseSeedScript = resolve(root, 'services/agent-host/project-vm-seed-supabase.sh')
const projectSupabaseController = resolve(root, 'services/agent-host/project-supabase-runtime.mjs')
const projectSupabaseBundleVerifier = resolve(root, 'scripts/lib/project-supabase-bundle.mjs')
const projectSupabaseReleaseTrust = resolve(root, 'services/project-supabase/release-trust.json')
const projectSupabaseRuntimeSpec = resolve(root, '.openlink-runtime/project-supabase/runtime.spec.json')
// Keep the bootable OS aligned with the bundled Podman client.  The generic
// 6.0 manifest has intermittently stalled on Quay; 6.2 is the current
// machine-os release and is still a multi-arch manifest selected by Podman.
const baseImage = process.env.OPENLINK_MACHINE_OS_IMAGE || 'quay.io/podman/machine-os:6.2'
// A release builder can work from a previously attested local OCI archive
// when registry access is unavailable. The override is deliberately the
// selected platform manifest (not a floating tag) and is accepted only when
// the local cache marker binds that digest to the requested base-image tag.
const baseImagePlatformDigestOverride = process.env.OPENLINK_MACHINE_OS_PLATFORM_DIGEST
const ociCacheDirectory = resolve(root, '.openlink-runtime/oci-cache')
const artifactOptions = { cwd: root, timeout: 60 * 60 * 1000 }

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
}

function guestProxy(value) {
  if (!value) return undefined
  return value
    .replaceAll('://127.0.0.1:', '://host.containers.internal:')
    .replaceAll('://localhost:', '://host.containers.internal:')
}

function guestBuildEnvironment() {
  return [
    ['HTTP_PROXY', guestProxy(process.env.HTTP_PROXY || process.env.http_proxy)],
    ['HTTPS_PROXY', guestProxy(process.env.HTTPS_PROXY || process.env.https_proxy)],
    ['NO_PROXY', process.env.NO_PROXY || process.env.no_proxy],
  ].filter(([, value]) => value)
}

async function exists(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function validArchive(path) {
  if (!(await exists(path))) return false
  return (await stat(path)).size > 1024 * 1024
}

function runCurl(args) {
  return new Promise((resolveCurl, rejectCurl) => {
    // Force the HTTP CONNECT proxy path.  A global SOCKS ALL_PROXY may route
    // the same request over a distinct unstable path even when HTTPS_PROXY is
    // configured, which is exactly the failure mode this acquisition layer
    // exists to avoid.
    const environment = { ...process.env }
    delete environment.ALL_PROXY
    delete environment.all_proxy
    const child = spawn('curl', ['--connect-timeout', '10', '--max-time', '60', ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: environment })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectCurl)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveCurl(Buffer.concat(chunks))
      else rejectCurl(new Error(`OCI registry download failed (${code ?? signal ?? 'unknown'}): ${stderr.trim()}`))
    })
  })
}

function registryHeaders(token, accept) {
  return [
    '--header', `Authorization: Bearer ${token}`,
    '--header', `Accept: ${accept}`,
  ]
}

async function downloadJson(url, token, accept) {
  const body = await runCurl([
    '--fail', '--location', '--silent', '--show-error',
    '--retry', '8', '--retry-all-errors', '--retry-delay', '5',
    ...registryHeaders(token, accept), url,
  ])
  return JSON.parse(body.toString('utf8'))
}

const OCI_TRANSFER_CHUNK_BYTES = Number.parseInt(process.env.OPENLINK_OCI_TRANSFER_CHUNK_BYTES || String(4 * 1024 * 1024), 10)
if (!Number.isSafeInteger(OCI_TRANSFER_CHUNK_BYTES) || OCI_TRANSFER_CHUNK_BYTES < 64 * 1024 || OCI_TRANSFER_CHUNK_BYTES > 32 * 1024 * 1024) {
  throw new Error('OPENLINK_OCI_TRANSFER_CHUNK_BYTES must be between 64 KiB and 32 MiB')
}

async function downloadBlob(url, token, destination, expectedDigest, expectedSize) {
  try {
    if ((await stat(destination)).size === expectedSize) {
      const cachedDigest = createHash('sha256').update(await readFile(destination)).digest('hex')
      if (`sha256:${cachedDigest}` === expectedDigest) return
      await rm(destination, { force: true })
    }
  } catch {}
  await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 })
  let downloaded = 0
  try { downloaded = (await stat(destination)).size } catch {}
  // A previous transfer from an older client may end inside a range. Starting
  // that blob over is safer than appending an overlapping byte sequence.
  if (downloaded % OCI_TRANSFER_CHUNK_BYTES !== 0) {
    await rm(destination, { force: true })
    downloaded = 0
  }
  while (downloaded < expectedSize) {
    const rangeEnd = Math.min(downloaded + OCI_TRANSFER_CHUNK_BYTES, expectedSize) - 1
    const chunkPath = `${destination}.${downloaded}-${rangeEnd}.part`
    await rm(chunkPath, { force: true })
    await runCurl([
      '--fail', '--location', '--silent', '--show-error',
      '--retry', '8', '--retry-all-errors', '--retry-delay', '5',
      '--range', `${downloaded}-${rangeEnd}`, '--output', chunkPath,
      ...registryHeaders(token, 'application/octet-stream'), url,
    ])
    const chunk = await readFile(chunkPath)
    await rm(chunkPath, { force: true })
    const expectedChunkSize = rangeEnd - downloaded + 1
    if (chunk.length !== expectedChunkSize) {
      throw new Error(`OCI range transfer returned ${chunk.length} bytes for ${basename(destination)}, expected ${expectedChunkSize}`)
    }
    await appendFile(destination, chunk, { mode: 0o600 })
    downloaded += chunk.length
  }
  const received = (await stat(destination)).size
  if (received !== expectedSize) {
    throw new Error(`OCI layer integrity check failed for ${basename(destination)}: expected ${expectedSize} bytes, received ${received}`)
  }
  const receivedDigest = createHash('sha256').update(await readFile(destination)).digest('hex')
  if (`sha256:${receivedDigest}` !== expectedDigest) {
    throw new Error(`OCI layer digest check failed for ${basename(destination)}`)
  }
}

/**
 * Acquire a registry image as an OCI archive before it enters the Builder VM.
 * The archive is content-addressed and each blob resumes independently. This
 * avoids containers/image's concurrent proxy transfer path while preserving
 * the original image manifest and digest verification performed by Podman.
 */
async function ensureMachineOsArchive(image) {
  const matched = image.match(/^([^/]+)\/(.+):([^:@]+)$/)
  if (!matched) throw new Error(`OPENLINK_MACHINE_OS_IMAGE must be registry/repository:tag, received ${image}`)
  const [, registry, repository, tag] = matched
  const architecture = nodeArchitecture()
  if (baseImagePlatformDigestOverride) {
    if (!/^sha256:[a-f0-9]{64}$/.test(baseImagePlatformDigestOverride)) {
      throw new Error('OPENLINK_MACHINE_OS_PLATFORM_DIGEST must be a sha256 platform manifest digest')
    }
    const digest = baseImagePlatformDigestOverride.slice('sha256:'.length)
    const layout = resolve(ociCacheDirectory, `${registry.replaceAll('.', '_')}-${repository.replaceAll('/', '_')}-${digest}`)
    const archivePath = `${layout}.oci.tar`
    const completeMarker = resolve(layout, '.complete.json')
    let marker
    try { marker = JSON.parse(await readFile(completeMarker, 'utf8')) } catch {}
    if (marker?.digest !== baseImagePlatformDigestOverride || marker?.image !== image || !(await validArchive(archivePath))) {
      throw new Error(`OPENLINK_MACHINE_OS_PLATFORM_DIGEST requires a complete attested local OCI archive for ${image}`)
    }
    return {
      archivePath,
      imageReference: `oci-archive:${archivePath}:openlink-machine-os`,
      platform: { os: 'linux', architecture, digest: baseImagePlatformDigestOverride },
    }
  }
  const scope = `repository:${repository}:pull`
  const tokenResponse = await runCurl([
    '--fail', '--location', '--silent', '--show-error',
    '--retry', '8', '--retry-all-errors', '--retry-delay', '5',
    `https://${registry}/v2/auth?service=${encodeURIComponent(registry)}&scope=${encodeURIComponent(scope)}`,
  ])
  const token = JSON.parse(tokenResponse.toString('utf8')).token
  if (typeof token !== 'string' || !token) throw new Error(`Registry ${registry} did not provide a pull token`)
  const index = await downloadJson(
    `https://${registry}/v2/${repository}/manifests/${tag}`,
    token,
    'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
  )
  const descriptor = index.manifests?.find((candidate) => candidate.platform?.os === 'linux' && candidate.platform?.architecture === architecture)
  if (!descriptor?.digest || typeof descriptor.size !== 'number') {
    throw new Error(`Registry image ${image} has no linux/${architecture} manifest`)
  }
  const manifestBytes = await runCurl([
    '--fail', '--location', '--silent', '--show-error',
    '--retry', '8', '--retry-all-errors', '--retry-delay', '5',
    ...registryHeaders(token, 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'),
    `https://${registry}/v2/${repository}/manifests/${descriptor.digest}`,
  ])
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (!manifest.config?.digest || typeof manifest.config.size !== 'number' || !Array.isArray(manifest.layers)) {
    throw new Error(`Registry image ${image} returned an invalid platform manifest`)
  }
  const digest = descriptor.digest.replace(/^sha256:/, '')
  const layout = resolve(ociCacheDirectory, `${registry.replaceAll('.', '_')}-${repository.replaceAll('/', '_')}-${digest}`)
  const archivePath = `${layout}.oci.tar`
  const completeMarker = resolve(layout, '.complete.json')
  let complete = false
  try {
    const marker = JSON.parse(await readFile(completeMarker, 'utf8'))
    complete = marker.digest === descriptor.digest && await validArchive(archivePath)
  } catch {}
  if (complete) return {
    archivePath,
    imageReference: `oci-archive:${archivePath}:openlink-machine-os`,
    platform: { os: 'linux', architecture, digest: descriptor.digest },
  }

  const blobs = [manifest.config, ...manifest.layers]
  await mkdir(resolve(layout, 'blobs/sha256'), { recursive: true, mode: 0o700 })
  for (const blob of blobs) {
    if (!blob?.digest?.startsWith('sha256:') || typeof blob.size !== 'number') throw new Error(`Registry image ${image} contains an invalid blob descriptor`)
    await downloadBlob(
      `https://${registry}/v2/${repository}/blobs/${blob.digest}`,
      token,
      resolve(layout, 'blobs/sha256', blob.digest.slice('sha256:'.length)),
      blob.digest,
      blob.size,
    )
  }
  if (createHash('sha256').update(manifestBytes).digest('hex') !== digest) {
    throw new Error(`Registry manifest digest check failed for ${image}`)
  }
  await writeFile(resolve(layout, 'blobs/sha256', digest), manifestBytes, { mode: 0o600 })
  await writeFile(resolve(layout, 'oci-layout'), `${JSON.stringify({ imageLayoutVersion: '1.0.0' })}\n`, { mode: 0o600 })
  await writeFile(resolve(layout, 'index.json'), `${JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: descriptor.digest,
      size: manifestBytes.length,
      annotations: { 'org.opencontainers.image.ref.name': 'openlink-machine-os' },
    }],
  })}\n`, { mode: 0o600 })
  const temporaryArchivePath = `${archivePath}.${process.pid}.tmp`
  await rm(temporaryArchivePath, { force: true })
  await run('tar', ['-C', layout, '-cf', temporaryArchivePath, '.'], { cwd: root })
  if (!(await validArchive(temporaryArchivePath))) throw new Error(`OCI cache archive for ${image} is invalid`)
  await rename(temporaryArchivePath, archivePath)
  await writeFile(completeMarker, `${JSON.stringify({ digest: descriptor.digest, image, bytes: (await stat(archivePath)).size })}\n`, { mode: 0o600 })
  return {
    archivePath,
    imageReference: `oci-archive:${archivePath}:openlink-machine-os`,
    platform: { os: 'linux', architecture, digest: descriptor.digest },
  }
}

const projectSupabaseLock = await readProjectSupabaseLock(projectSupabaseLockPath)
const observedProjectSupabaseConfigurationHash = await hashConfigurationTree(projectSupabaseConfiguration)
if (observedProjectSupabaseConfigurationHash !== projectSupabaseLock.configuration.treeSha256) {
  throw new Error('Project Supabase configuration must be synchronized and match the reviewed lock before building the Project VM base')
}
const projectSupabaseLockSha256 = createHash('sha256').update(await readFile(projectSupabaseLockPath)).digest('hex')
const projectSupabaseSeedSha256 = createHash('sha256').update(await readFile(projectSupabaseSeedScript)).digest('hex')
const projectSupabaseControllerSha256 = createHash('sha256').update(await readFile(projectSupabaseController)).digest('hex')
const projectSupabaseBundleVerifierSha256 = createHash('sha256').update(await readFile(projectSupabaseBundleVerifier)).digest('hex')
const projectSupabaseReleaseTrustSha256 = createHash('sha256').update(await readFile(projectSupabaseReleaseTrust)).digest('hex')
const projectSupabaseRuntimeSpecSha256 = createHash('sha256').update(await readFile(projectSupabaseRuntimeSpec)).digest('hex')
if (projectSupabaseRuntimeSpecSha256 !== projectSupabaseLock.configuration.runtimeSpecSha256) throw new Error('Project Supabase runtime spec does not match the reviewed lock')
const machineOs = await ensureMachineOsArchive(baseImage)

const fingerprint = createHash('sha256')
  .update(await readFile(containerfile))
  .update(JSON.stringify({ schemaVersion: 2, baseImage, baseImagePlatform: machineOs.platform, packages: ['bash-completion', 'ca-certificates', 'cmake', 'curl', 'diffutils', 'fd-find', 'findutils', 'git', 'gzip', 'jq', 'make', 'nodejs', 'npm', 'openssh-clients', 'pnpm', 'procps-ng', 'python3', 'python3-devel', 'python3-pip', 'qemu-img', 'ripgrep', 'tar', 'unzip', 'wget', 'which', 'xz', 'zip', 'gcc', 'gcc-c++'], projectSupabaseLockSha256, projectSupabaseSeedSha256, projectSupabaseControllerSha256, projectSupabaseBundleVerifierSha256, projectSupabaseReleaseTrustSha256, projectSupabaseRuntimeSpecSha256, projectSupabaseConfigurationHash: observedProjectSupabaseConfigurationHash }))
  .digest('hex')

let previous
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {}
if (previous?.schemaVersion === 2 && previous.fingerprint === fingerprint && await validArchive(archive)) {
  process.stdout.write(`${JSON.stringify({ archive, fingerprint, reused: true, bytes: (await stat(archive)).size })}\n`)
  process.exit(0)
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
const context = await mkdtemp(resolve(outputDirectory, '.build-context-'))
const nonce = `${process.pid}-${randomBytes(8).toString('hex')}`
const guestRoot = `/var/home/core/.cache/openlink-project-vm-base/${nonce}`
const guestContext = `${guestRoot}/context`
const guestContainerfile = `${guestContext}/Containerfile`
const guestArchive = `${guestRoot}/openlink-project-vm-base.oci.tar`
const guestMachineOsArchive = `${guestRoot}/machine-os.oci.tar`
const temporaryArchive = `${archive}.${process.pid}.tmp`
let builder

try {
  await cp(containerfile, resolve(context, 'Containerfile'))
  await mkdir(resolve(context, 'project-supabase'), { recursive: true, mode: 0o700 })
  await cp(projectSupabaseLockPath, resolve(context, 'project-supabase/runtime.lock.json'))
  await cp(projectSupabaseReleaseTrust, resolve(context, 'project-supabase/release-trust.json'))
  await cp(projectSupabaseConfiguration, resolve(context, 'project-supabase/configuration'), { recursive: true, preserveTimestamps: true })
  await cp(projectSupabaseRuntimeSpec, resolve(context, 'project-supabase/runtime.spec.json'))
  await cp(projectSupabaseSeedScript, resolve(context, 'project-vm-seed-supabase.sh'))
  await cp(projectSupabaseController, resolve(context, 'project-supabase-runtime.mjs'))
  await cp(projectSupabaseBundleVerifier, resolve(context, 'project-supabase-bundle.mjs'))
  await writeFile(resolve(context, 'project-vm-base.json'), `${JSON.stringify({ schemaVersion: 2, fingerprint, baseImage, baseImagePlatform: machineOs.platform, builtFor: 'OpenLink Project VM', projectSupabase: { release: projectSupabaseLock.release.tag, commit: projectSupabaseLock.release.commit, configurationTreeSha256: projectSupabaseLock.configuration.treeSha256, lockSha256: projectSupabaseLockSha256 } })}\n`, { mode: 0o600 })

  builder = await ensurePodmanBuilder(podman, artifactOptions)
  await run(podman, ['machine', 'ssh', builder.machineName, `mkdir -p ${shellQuote(guestRoot)}`], artifactOptions)
  await run(podman, ['machine', 'cp', context, `${builder.machineName}:${guestContext}`], artifactOptions)
  await run(podman, ['machine', 'cp', machineOs.archivePath, `${builder.machineName}:${guestMachineOsArchive}`], artifactOptions)
  const tag = `openlink/project-vm-base:${fingerprint.slice(0, 20)}`
  // Import the verified OCI archive into the Builder VM, tag it with the
  // Containerfile reference, then forbid network pulls during the build.
  const pull = ['podman', 'pull', '--quiet', machineOs.imageReference.replace(machineOs.archivePath, guestMachineOsArchive)]
    .map(shellQuote)
    .join(' ')
  const retag = ['podman', 'tag', 'localhost/openlink-machine-os:latest', baseImage]
    .map(shellQuote)
    .join(' ')
  // OCI acquisition is explicitly proxied above. Package metadata and RPMs
  // inside the immutable build use the host's direct network path instead of
  // inheriting a proxy that has already demonstrated long-transfer stalls.
  const build = ['podman', 'build', '--pull-never', '--http-proxy=false', '--tag', tag, '--build-arg', `OPENLINK_MACHINE_OS_IMAGE=${baseImage}`, '--file', guestContainerfile, guestContext]
    .map(shellQuote)
    .join(' ')
  const save = ['podman', 'save', '--format', 'oci-archive', '--output', guestArchive, tag]
    .map(shellQuote)
    .join(' ')
  const environment = guestBuildEnvironment().map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ')
  await run(podman, ['machine', 'ssh', builder.machineName, `env ${environment} ${pull} && ${retag} && ${build} && ${save}`], artifactOptions)
  await rm(temporaryArchive, { force: true })
  await run(podman, ['machine', 'cp', `${builder.machineName}:${guestArchive}`, temporaryArchive], artifactOptions)
  if (!(await validArchive(temporaryArchive))) throw new Error('Project VM base build produced an invalid OCI archive')
  await rename(temporaryArchive, archive)
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 2,
    fingerprint,
    baseImage,
    baseImagePlatform: machineOs.platform,
    projectSupabase: {
      release: projectSupabaseLock.release.tag,
      commit: projectSupabaseLock.release.commit,
      configurationTreeSha256: projectSupabaseLock.configuration.treeSha256,
      lockSha256: projectSupabaseLockSha256,
      seedScriptSha256: projectSupabaseSeedSha256,
      controllerSha256: projectSupabaseControllerSha256,
      bundleVerifierSha256: projectSupabaseBundleVerifierSha256,
      releaseTrustSha256: projectSupabaseReleaseTrustSha256,
      runtimeSpecSha256: projectSupabaseRuntimeSpecSha256,
    },
    archive: basename(archive),
    bytes: (await stat(archive)).size,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ archive, fingerprint, reused: false, bytes: (await stat(archive)).size })}\n`)
} finally {
  await rm(context, { recursive: true, force: true })
  await rm(temporaryArchive, { force: true })
  if (builder) {
    await run(podman, ['machine', 'ssh', builder.machineName, `rm -rf ${shellQuote(guestRoot)}`], artifactOptions).catch(() => {})
    await stopPodmanBuilder(podman, builder.machineName, artifactOptions)
  }
}
