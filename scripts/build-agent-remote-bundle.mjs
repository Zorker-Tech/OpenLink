import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensurePodmanBuilder, stopPodmanBuilder } from './lib/podman-builder.mjs'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'
import { sourceRevision } from './lib/monorepo-sources.mjs'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
await configureBundledPodmanRuntime(root)

function argumentsFrom(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  return values
}

function safeId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('release-id is invalid')
  return value
}

function safeRemoteRoot(value) {
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) || value.split('/').includes('..')) throw new Error('remote-root is invalid')
  return value.replace(/\/+$/, '') || '/'
}

async function command(file, args, options = {}) {
  process.stdout.write(`> ${file} ${args.join(' ')}\n`)
  await run(file, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...options })
}

const args = argumentsFrom(process.argv.slice(2))
const releaseId = safeId(args.get('release-id') || new Date().toISOString().replace(/[:]/g, '-'))
const remoteRoot = safeRemoteRoot(args.get('remote-root') || '/var/lib/openlink-agent')
const platform = args.get('platform') || 'linux/amd64'
if (!/^linux\/(amd64|arm64)$/.test(platform)) throw new Error('platform must be linux/amd64 or linux/arm64')
const outputRoot = resolve(args.get('output') || join(root, '.openlink-releases'))
const releaseDirectory = join(outputRoot, releaseId)
const staging = await mkdtemp(join(tmpdir(), 'openlink-agent-release-'))
const imagesDirectory = join(staging, 'images')
const toolchainDirectory = join(staging, 'toolchain')
const podmanCachePath = join(root, '.openlink-runtime', 'toolchain', 'linux', platform.slice('linux/'.length), 'podman')
const hostPodman = process.env.OPENLINK_PODMAN_COMMAND || join(root, '.openlink-runtime', 'toolchain', 'bin', 'podman')

const serverImage = `openlink/opensandbox-server:${releaseId}`
const execdImage = `openlink/opensandbox-execd:${releaseId}`
const egressImage = `openlink/opensandbox-egress:${releaseId}`
const rpcImage = `openlink/agent-rpc-worker:${releaseId}`
const agentWorkerImage = `openlink/agent-worker:${releaseId}`
const browserHostImage = `openlink/browser-host:${releaseId}`
const codeServerImage = `openlink/code-server:${releaseId}`
const baseImageUrl = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img'
const baseImageSha256 = '0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe'

let builder
try {
  await command(process.execPath, ['scripts/sync-pi-runtime.mjs', '--check'])
  await mkdir(imagesDirectory, { recursive: true })
  await mkdir(toolchainDirectory, { recursive: true })
  await mkdir(releaseDirectory, { recursive: true })

  await command(process.execPath, ['scripts/build-podman-linux.mjs', '--platform', platform, '--output', podmanCachePath])
  await cp(podmanCachePath, join(toolchainDirectory, 'podman'))
  await run('chmod', ['755', join(toolchainDirectory, 'podman')])

  builder = await ensurePodmanBuilder(hostPodman, { cwd: root })
  const { connectionArgs } = builder
  await command(hostPodman, [...connectionArgs, 'build', '--platform', platform, '-t', serverImage, 'services/opensandbox/server'])
  await command(hostPodman, [...connectionArgs, 'build', '--platform', platform, '-f', 'services/opensandbox/components/execd/Dockerfile', '-t', execdImage, 'services/opensandbox'])
  await command(hostPodman, [...connectionArgs, 'build', '--platform', platform, '-f', 'services/opensandbox/components/egress/Dockerfile', '-t', egressImage, 'services/opensandbox'])
  await command(hostPodman, [...connectionArgs, 'build', '--platform', platform, '-f', 'services/agent-rpc-worker/Dockerfile', '-t', rpcImage, '.'])
  await command(hostPodman, [...connectionArgs, 'build', '--platform', platform, '-f', 'services/agent-worker/Dockerfile', '-t', agentWorkerImage, '.'])
  await command(hostPodman, [...connectionArgs, 'build', '--platform', platform, '-f', 'services/browser-host/Containerfile', '-t', browserHostImage, '.'])
  await command(hostPodman, [...connectionArgs, 'build', '--platform', platform, '-f', 'services/code-server/Containerfile', '-t', codeServerImage, 'services/code-server'])
  await command(hostPodman, [...connectionArgs, 'save', '-o', join(imagesDirectory, 'openlink-agent-images.tar'), serverImage, execdImage, egressImage, rpcImage, agentWorkerImage, browserHostImage, codeServerImage])

  await cp(join(root, 'services/agent-remote-release/project-vm.sh'), join(staging, 'project-vm.sh'))
  await run('chmod', ['700', join(staging, 'project-vm.sh')])

  const archive = join(releaseDirectory, 'openlink-agent-bundle.tar.gz')
  await command('tar', ['-czf', archive, '-C', staging, '.'])
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  // The SSH bootstrap uploads the archive as `bundle.tar.gz`; keep the
  // manifest path aligned with that transport name so `sha256sum -c` verifies
  // the exact file that will be extracted on the target.
  const remoteArchive = `${remoteRoot}/releases/${releaseId}/bundle.tar.gz`
  const checksum = join(releaseDirectory, 'bundle.sha256')
  await writeFile(checksum, `${digest}  ${remoteArchive}\n`, { mode: 0o644 })
  const opensandboxCommit = sourceRevision('opensandbox')
  const piCommit = sourceRevision('pi')
  const podmanSha256 = createHash('sha256').update(await readFile(join(toolchainDirectory, 'podman'))).digest('hex')
  const piRuntimeManifestSha256 = createHash('sha256')
    .update(await readFile(join(root, 'packages/pi-runtime/manifest.json')))
    .digest('hex')
  await writeFile(join(releaseDirectory, 'release.json'), JSON.stringify({
    releaseId,
    platform,
    remoteRoot,
    bundleSha256: digest,
    opensandboxCommit,
    piCommit,
    piRuntimeManifestSha256,
    podman: { path: 'toolchain/podman', sha256: podmanSha256 },
    images: { serverImage, execdImage, egressImage, rpcImage, agentWorkerImage, browserHostImage, codeServerImage },
    projectVmBaseImage: { url: baseImageUrl, sha256: baseImageSha256 },
  }, null, 2) + '\n')
  process.stdout.write(`${JSON.stringify({ releaseId, archive, checksum, bundleSha256: digest }, null, 2)}\n`)
} finally {
  if (builder) await stopPodmanBuilder(hostPodman, builder.machineName, { cwd: root })
  await rm(staging, { recursive: true, force: true })
}
