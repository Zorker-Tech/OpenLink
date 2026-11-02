import { createHash, randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localRuntimeCacheRoot } from './lib/local-runtime-cache.mjs'
import { ensurePodmanBuilder, run, stopPodmanBuilder } from './lib/podman-builder.mjs'
import { ensureDockerEngine } from './lib/docker-runtime.mjs'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const imageRoot = process.env.OPENLINK_RUNTIME_IMAGE_ROOT?.trim()
  ? resolve(process.env.OPENLINK_RUNTIME_IMAGE_ROOT)
  : process.platform === 'linux' && process.env.OPENLINK_BUILD_ARTIFACTS !== '1'
    ? resolve(localRuntimeCacheRoot(), 'project-images')
    : resolve(root, '.openlink-runtime/images')
const manifestPath = resolve(imageRoot, 'manifest.json')
const requestedBuilder = process.env.OPENLINK_IMAGE_BUILDER?.trim().toLowerCase()
const builderKind = requestedBuilder || (process.platform === 'linux' ? 'docker' : 'podman')
if (!['docker', 'podman'].includes(builderKind)) throw new Error('OPENLINK_IMAGE_BUILDER must be docker or podman')
const nativeArchitecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined
if (!nativeArchitecture) throw new Error(`Unsupported runtime image build architecture ${process.arch}`)
const platform = process.env.OPENLINK_IMAGE_PLATFORM || `linux/${nativeArchitecture}`
if (!/^linux\/(amd64|arm64)$/.test(platform)) throw new Error('OPENLINK_IMAGE_PLATFORM must be linux/amd64 or linux/arm64')
const imageBuildNetwork = process.env.OPENLINK_IMAGE_BUILD_NETWORK?.trim()
if (imageBuildNetwork && !['default', 'host', 'none'].includes(imageBuildNetwork)) {
  throw new Error('OPENLINK_IMAGE_BUILD_NETWORK must be default, host, or none')
}
if (builderKind === 'podman') await configureBundledPodmanRuntime(root)
const podman = process.env.OPENLINK_PODMAN_COMMAND || resolve(root, '.openlink-runtime/toolchain/bin/podman')
const force = process.env.OPENLINK_FORCE_RUNTIME_IMAGES === '1'
const requestedImages = process.env.OPENLINK_RUNTIME_IMAGES
  ? new Set(process.env.OPENLINK_RUNTIME_IMAGES.split(',').map((value) => value.trim()).filter(Boolean))
  : undefined

function archiveName(image) {
  return `${image.replaceAll('/', '_').replaceAll(':', '_')}.tar`
}

const specs = [
  {
    image: 'openlink/agent-worker:dev',
    dockerfile: 'services/agent-worker/Dockerfile',
    context: '.',
    inputs: [
      'services/agent-worker/Dockerfile',
      'services/agent-worker/desktop/start.sh',
      'services/agent-worker/desktop/run-ubuntu-vm.sh',
      'services/agent-worker/desktop/qmp-control.py',
      'services/agent-worker/package.json',
      'services/agent-worker/package-lock.json',
      'services/agent-worker/dist',
      'services/agent-browser-extension/openlink-browser.ts',
      'services/agent-supabase-extension/openlink-supabase.ts',
      'services/agent-desktop-extension/openlink-desktop.ts',
      'packages/pi-runtime/manifest.json',
      'packages/pi-runtime/tarballs',
    ],
    contextProjection: [
      'packages/pi-runtime/tarballs',
      'services/agent-worker/desktop/start.sh',
      'services/agent-worker/desktop/run-ubuntu-vm.sh',
      'services/agent-worker/desktop/qmp-control.py',
      'services/agent-worker/package.json',
      'services/agent-worker/package-lock.json',
      'services/agent-worker/dist',
      'services/agent-browser-extension/openlink-browser.ts',
      'services/agent-supabase-extension/openlink-supabase.ts',
      'services/agent-desktop-extension/openlink-desktop.ts',
    ],
  },
  {
    image: 'openlink/agent-rpc-worker:dev',
    dockerfile: 'services/agent-rpc-worker/Dockerfile',
    context: '.',
    inputs: [
      'services/agent-rpc-worker/Dockerfile',
      'services/agent-worker/desktop/start.sh',
      'services/agent-worker/desktop/run-ubuntu-vm.sh',
      'services/agent-worker/desktop/qmp-control.py',
      'services/agent-rpc-worker/package.json',
      'services/agent-rpc-worker/package-lock.json',
      'services/agent-rpc-worker/dist',
      'services/agent-browser-extension/openlink-browser.ts',
      'services/agent-supabase-extension/openlink-supabase.ts',
      'services/agent-desktop-extension/openlink-desktop.ts',
      'packages/pi-runtime/manifest.json',
      'packages/pi-runtime/tarballs',
    ],
    contextProjection: [
      'packages/pi-runtime/tarballs',
      'services/agent-worker/desktop/start.sh',
      'services/agent-worker/desktop/run-ubuntu-vm.sh',
      'services/agent-worker/desktop/qmp-control.py',
      'services/agent-rpc-worker/package.json',
      'services/agent-rpc-worker/package-lock.json',
      'services/agent-rpc-worker/dist',
      'services/agent-browser-extension/openlink-browser.ts',
      'services/agent-supabase-extension/openlink-supabase.ts',
      'services/agent-desktop-extension/openlink-desktop.ts',
    ],
  },
  {
    image: 'openlink/browser-host:dev',
    dockerfile: 'services/browser-host/Containerfile',
    context: '.',
    inputs: [
      'services/browser-host/Containerfile',
      'services/browser-host/package.json',
      'services/browser-host/package-lock.json',
      'services/browser-host/dist',
      'packages/browser-protocol/package.json',
      'packages/browser-protocol/dist',
    ],
    contextProjection: [
      'packages/browser-protocol/package.json',
      'packages/browser-protocol/dist',
      'services/browser-host/package.json',
      'services/browser-host/package-lock.json',
      'services/browser-host/dist',
    ],
  },
  {
    image: 'openlink/code-server:dev',
    dockerfile: 'services/code-server/Containerfile',
    context: '.',
    inputs: [
      'services/code-server/Containerfile',
    ],
    contextProjection: [],
  },
  {
    image: 'openlink/opensandbox-server:dev',
    dockerfile: 'services/opensandbox/server/Dockerfile',
    context: 'services/opensandbox/server',
    inputs: [
      'services/opensandbox/server/Dockerfile',
      'services/opensandbox/server/pyproject.toml',
      'services/opensandbox/server/uv.lock',
      'services/opensandbox/server/opensandbox_server',
      'services/opensandbox/server/LICENSE',
      'services/opensandbox/server/README.md',
    ],
    contextPrefix: 'services/opensandbox/server',
    contextProjection: [
      'services/opensandbox/server/pyproject.toml',
      'services/opensandbox/server/uv.lock',
      'services/opensandbox/server/opensandbox_server',
      'services/opensandbox/server/LICENSE',
      'services/opensandbox/server/README.md',
    ],
  },
  {
    image: 'openlink/opensandbox-execd:dev',
    dockerfile: 'services/opensandbox/components/execd/Dockerfile',
    context: 'services/opensandbox',
    inputs: [
      'services/opensandbox/.containerignore',
      'services/opensandbox/components/execd',
      'services/opensandbox/components/internal',
    ],
    contextProjection: [
      'services/opensandbox/components/execd',
      'services/opensandbox/components/internal',
    ],
    contextPrefix: 'services/opensandbox',
  },
  {
    image: 'openlink/opensandbox-egress:dev',
    dockerfile: 'services/opensandbox/components/egress/Dockerfile',
    context: 'services/opensandbox',
    inputs: [
      'services/opensandbox/.containerignore',
      'services/opensandbox/components/egress',
      'services/opensandbox/components/internal',
    ],
    contextProjection: [
      'services/opensandbox/components/egress',
      'services/opensandbox/components/internal',
    ],
    contextPrefix: 'services/opensandbox',
  },
]

async function hashPath(hash, absolutePath) {
  const metadata = await lstat(absolutePath)
  const path = relative(root, absolutePath)
  hash.update(`${path}\0${metadata.mode}\0`)
  if (metadata.isSymbolicLink()) {
    hash.update(`link\0${await readlink(absolutePath)}\0`)
    return
  }
  if (metadata.isDirectory()) {
    hash.update('directory\0')
    const entries = (await readdir(absolutePath)).sort()
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules' || entry === '__pycache__') continue
      await hashPath(hash, resolve(absolutePath, entry))
    }
    return
  }
  hash.update('file\0')
  hash.update(await readFile(absolutePath))
  hash.update('\0')
}

async function fingerprint(spec) {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ schemaVersion: 2, image: spec.image, dockerfile: spec.dockerfile, context: spec.context, platform }))
  for (const input of spec.inputs) await hashPath(hash, resolve(root, input))
  return hash.digest('hex')
}

async function validArchive(path) {
  try {
    return (await lstat(path)).isFile() && (await lstat(path)).size > 0
  } catch {
    return false
  }
}

async function persistManifest(manifest) {
  const temporary = `${manifestPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, manifestPath)
}

/**
 * Podman's macOS remote client uploads the entire context before the daemon
 * sees a build request. OpenSandbox is an intentionally large source tree,
 * while the execd and egress Containerfiles COPY only two component trees.
 * Materialize those exact inputs into a short-lived context so this remains a
 * deterministic full build without streaming docs, SDKs or the upstream git
 * checkout through the VM control socket.
 */
async function materializeContext(spec) {
  const context = await mkdtemp(resolve(imageRoot, '.build-context-'))
  try {
    for (const input of spec.contextProjection) {
      const source = resolve(root, input)
      const destination = resolve(context, spec.contextPrefix
        ? input.replace(new RegExp(`^${spec.contextPrefix}/`), '')
        : input)
      await cp(source, destination, { recursive: true, preserveTimestamps: true })
    }
  } catch (error) {
    await rm(context, { recursive: true, force: true })
    throw error
  }
  return { path: context, cleanup: async () => rm(context, { recursive: true, force: true }) }
}

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

async function buildInDedicatedMachine(builder, spec, context) {
  const nonce = randomBytes(12).toString('hex')
  const guestRoot = `/var/home/core/.cache/openlink-image-builds/${nonce}`
  const guestContext = `${guestRoot}/context`
  const guestDockerfile = `${guestRoot}/Containerfile`
  const guestArchive = `${guestRoot}/image.tar`
  const archive = `${spec.archive}.${process.pid}.tmp`
  const environment = guestBuildEnvironment().map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ')
  const build = ['podman', 'build', '--tag', spec.image, '--file', guestDockerfile, guestContext].map(shellQuote).join(' ')
  const save = ['podman', 'save', '--output', guestArchive, spec.image].map(shellQuote).join(' ')
  const command = `env ${environment} ${build} && ${save}`
  try {
    await run(podman, ['machine', 'ssh', builder.machineName, `mkdir -p ${shellQuote(guestRoot)}`], { cwd: root })
    await run(podman, ['machine', 'cp', context.path, `${builder.machineName}:${guestContext}`], { cwd: root })
    await run(podman, ['machine', 'cp', resolve(root, spec.dockerfile), `${builder.machineName}:${guestDockerfile}`], { cwd: root })
    // A cold image build (base image pull + dependency install) routinely
    // exceeds podman-builder's 2-minute default spawn timeout.
    await run(podman, ['machine', 'ssh', builder.machineName, command], { cwd: root, timeout: 60 * 60 * 1000 })
    await rm(archive, { force: true })
    await run(podman, ['machine', 'cp', `${builder.machineName}:${guestArchive}`, archive], { cwd: root, timeout: 15 * 60 * 1000 })
    await rename(archive, spec.archive)
  } finally {
    await rm(archive, { force: true })
    await run(podman, ['machine', 'ssh', builder.machineName, `rm -rf ${shellQuote(guestRoot)}`], { cwd: root }).catch(() => undefined)
  }
}

await mkdir(imageRoot, { recursive: true, mode: 0o700 })
let previous = { schemaVersion: 1, images: {} }
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {}
if (![1, 2].includes(previous.schemaVersion) || typeof previous.images !== 'object') previous = { schemaVersion: 1, images: {} }

const resolved = []
for (const spec of specs.filter((item) => !requestedImages || requestedImages.has(item.image))) {
  const archive = resolve(imageRoot, archiveName(spec.image))
  resolved.push({ ...spec, archive, fingerprint: await fingerprint(spec) })
}
const changed = []
const archives = {}
for (const spec of resolved) {
  archives[spec.image] = spec.archive
  if (force || previous.images[spec.image]?.fingerprint !== spec.fingerprint || !(await validArchive(spec.archive))) changed.push(spec)
}

if (changed.length) {
  const docker = builderKind === 'docker' ? await ensureDockerEngine() : undefined
  const builder = builderKind === 'podman' ? await ensurePodmanBuilder(podman, { cwd: root }) : undefined
  try {
    const manifest = {
      ...previous,
      schemaVersion: 2,
      builder: builderKind,
      platform,
      ...(builderKind === 'podman' ? { builderMachine: builder.machineName } : { builderMachine: undefined }),
      images: { ...previous.images },
    }
    for (const spec of changed) {
      const context = await materializeContext(spec)
      try {
        if (builder?.machineName) {
          await buildInDedicatedMachine(builder, spec, context)
        } else if (builderKind === 'docker') {
          const buildArgs = ['build', '--platform', platform, '--tag', spec.image]
          if (imageBuildNetwork) buildArgs.push('--network', imageBuildNetwork)
          const buildEnvironment = { ...process.env }
          let usesHostGatewayProxy = false
          // Docker builds do not inherit the host process environment by
          // default. Forward only the proxy variable names so Docker reads
          // their values from this process environment without adding proxy
          // URLs to the command line or build logs. Loopback proxies need a
          // host-gateway alias because BuildKit's host network namespace may
          // differ from the Docker CLI host's loopback namespace.
          for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'FTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'ftp_proxy', 'no_proxy', 'all_proxy']) {
            const value = process.env[key]
            if (!value) continue
            buildArgs.push('--build-arg', key)
            try {
              const proxy = new URL(value)
              const hostname = proxy.hostname.replace(/^\[|\]$/g, '').toLowerCase()
              if (hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)) {
                proxy.hostname = 'host.docker.internal'
                buildEnvironment[key] = proxy.toString()
                usesHostGatewayProxy = true
              }
            } catch {}
          }
          if (usesHostGatewayProxy) buildArgs.push('--add-host', 'host.docker.internal:host-gateway')
          buildArgs.push('--file', resolve(root, spec.dockerfile), context.path)
          await run(docker, [
            ...buildArgs,
          ], { cwd: root, env: buildEnvironment, timeout: 60 * 60 * 1000 })
        } else {
          await run(podman, [
            ...builder.connectionArgs,
            'build',
            '--platform', platform,
            '--tag', spec.image,
            '--file', resolve(root, spec.dockerfile),
            context.path,
          ], { cwd: root })
        }
      } finally {
        await context.cleanup()
      }
      if (builderKind === 'docker') {
        const temporaryArchive = `${spec.archive}.${process.pid}.tmp`
        await rm(temporaryArchive, { force: true })
        await run(docker, ['image', 'save', '--platform', platform, '--output', temporaryArchive, spec.image], { cwd: root, timeout: 15 * 60 * 1000 })
        await rename(temporaryArchive, spec.archive)
      } else if (!builder?.machineName) {
        const temporaryArchive = `${spec.archive}.${process.pid}.tmp`
        await rm(temporaryArchive, { force: true })
        await run(podman, [...builder.connectionArgs, 'save', '--output', temporaryArchive, spec.image], { cwd: root })
        await rename(temporaryArchive, spec.archive)
      }
      manifest.images[spec.image] = {
        fingerprint: spec.fingerprint,
        archive: spec.archive,
        platform,
        builtAt: new Date().toISOString(),
      }
      await persistManifest(manifest)
    }
  } finally {
    if (builderKind === 'podman') await stopPodmanBuilder(podman, builder?.machineName, { cwd: root })
  }
}

process.stdout.write(`${JSON.stringify({ builder: builderKind, platform, archives, rebuilt: changed.map(({ image }) => image), reused: resolved.filter(({ image }) => !changed.some((item) => item.image === image)).map(({ image }) => image) })}\n`)
