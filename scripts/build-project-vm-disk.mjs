// Produce the bootable Project VM disk consumed by the runtime.
//
// The Containerfile build produces an OCI bootc image. OCI archives are not
// VM disks and must never be passed directly to `podman machine init`: on
// AppleHV that would copy the tar file to the raw-disk path and vfkit would
// immediately exit. This image-production step boots a temporary stock
// machine, applies the local OCI image with bootc, and publishes the resulting
// raw disk. Runtime startup only consumes that local disk and does no image
// build or registry pull.
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'
import { run, runCapture } from './lib/podman-builder.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
await configureBundledPodmanRuntime(root)

const podman = process.env.OPENLINK_PODMAN_COMMAND || resolve(root, '.openlink-runtime/toolchain/bin/podman')
const configRoot = process.env.XDG_CONFIG_HOME || resolve(root, '.openlink-runtime/podman-config')
const dataRoot = process.env.XDG_DATA_HOME || resolve(root, '.openlink-runtime/podman-data')
const provider = process.env.CONTAINERS_MACHINE_PROVIDER || 'applehv'
const outputRoot = resolve(root, '.openlink-runtime/project-vm-base')
const manifestPath = join(outputRoot, 'manifest.json')
const ociArchive = join(outputRoot, 'openlink-project-vm-base.oci.tar')
const machineName = process.env.OPENLINK_PROJECT_VM_IMAGE_MACHINE || 'openlink-project-vm-image-builder'
const rawDiskName = `openlink-project-vm-base-${process.arch}.raw`
const rawDiskPath = join(outputRoot, rawDiskName)

const podmanEnv = {
  XDG_CONFIG_HOME: configRoot,
  XDG_DATA_HOME: dataRoot,
  CONTAINERS_MACHINE_PROVIDER: provider,
  CONTAINERS_HELPER_BINARY_DIR: process.env.CONTAINERS_HELPER_BINARY_DIR || resolve(root, '.openlink-runtime/toolchain/bin'),
  PATH: `${process.env.CONTAINERS_HELPER_BINARY_DIR || resolve(root, '.openlink-runtime/toolchain/bin')}:${process.env.PATH || ''}`,
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`
}

async function machineExists() {
  return runCapture(podman, ['machine', 'inspect', machineName], { env: { ...process.env, ...podmanEnv } }).then(() => true).catch(() => false)
}

async function waitForSsh() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      await runCapture(podman, ['machine', 'ssh', machineName, 'true'], { env: { ...process.env, ...podmanEnv } })
      return
    } catch {
      await sleep(1_000)
    }
  }
  throw new Error(`Project VM image builder ${machineName} did not become ready`)
}

async function cachedMachineOs() {
  const roots = [
    join(dataRoot, 'containers/podman/machine', provider, 'cache'),
    join(process.env.HOME || '', '.local/share/containers/podman/machine', provider, 'cache'),
  ]
  const candidates = []
  for (const cacheRoot of roots) {
    for (const entry of await readdir(cacheRoot).catch(() => [])) {
      if (!entry.endsWith('.raw.zst')) continue
      const path = join(cacheRoot, entry)
      const metadata = await stat(path).catch(() => null)
      if (metadata?.isFile() && metadata.size > 0) candidates.push({ path, mtime: metadata.mtimeMs })
    }
  }
  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates[0]?.path
}

let manifest
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { manifest = undefined }
if (!manifest?.fingerprint || !(await stat(ociArchive).catch(() => null))) {
  throw new Error('Project VM OCI image must be built before the disk image')
}
if (manifest.disk && typeof manifest.disk === 'string' && manifest.disk === rawDiskName) {
  const existingDisk = await stat(rawDiskPath).catch(() => null)
  if (existingDisk?.isFile() && existingDisk.size > 1024 * 1024) {
    process.stdout.write(`${JSON.stringify({ disk: rawDiskPath, fingerprint: manifest.fingerprint, reused: true })}\n`)
    process.exit(0)
  }
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 })
let builderWasCreated = false
try {
  if (!(await machineExists())) {
    const cached = await cachedMachineOs()
    await run(podman, [
      'machine', 'init',
      ...(cached ? ['--image', cached] : []),
      '--rootful',
      '--cpus', process.env.OPENLINK_PROJECT_VM_IMAGE_CPUS || '4',
      '--memory', process.env.OPENLINK_PROJECT_VM_IMAGE_MEMORY_MB || '8192',
      '--disk-size', process.env.OPENLINK_PROJECT_VM_IMAGE_DISK_GB || '64',
      machineName,
    ], { env: { ...process.env, ...podmanEnv } })
    builderWasCreated = true
  }
  await run(podman, ['machine', 'start', machineName], { env: { ...process.env, ...podmanEnv } }).catch((error) => {
    if (!/already running|currently starting/i.test(error instanceof Error ? error.message : String(error))) throw error
  })
  await waitForSsh()

  const guestArchive = `/var/tmp/openlink-project-vm-base-${process.pid}-${randomBytes(6).toString('hex')}.oci.tar`
  const guestOutput = `/var/tmp/openlink-project-vm-output-${process.pid}-${randomBytes(6).toString('hex')}`
  const guestDisk = `${guestOutput}/${rawDiskName}`
  const imageRef = `openlink/project-vm-base:${String(manifest.fingerprint).slice(0, 20)}`
  await run(podman, ['machine', 'cp', ociArchive, `${machineName}:${guestArchive}`], { env: { ...process.env, ...podmanEnv } })
  // Convert the local OCI image into a fresh bootable disk. This avoids
  // cloning a booted VM's machine-id, SSH host keys, or Podman state into
  // every Project. bootc-image-builder is intentionally not a runtime
  // dependency; the bootc tooling already present in the custom image does
  // the conversion in the disposable builder VM.
  await run(podman, ['machine', 'ssh', machineName, [
    'sudo', 'mkdir', '-p', guestOutput,
  ].map(shellQuote).join(' ')], { env: { ...process.env, ...podmanEnv } })
  const loadCommand = ['sudo', 'podman', 'load', '-i', guestArchive].map(shellQuote).join(' ')
  const buildCommand = [
    'sudo', 'podman', 'run', '--rm', '--privileged', '--pid=host', '--ipc=host',
    '--security-opt', 'label=type:unconfined_t',
    '-v', '/dev:/dev', '-v', '/var/lib/containers:/var/lib/containers',
    '-v', `${guestOutput}:${guestOutput}`,
    imageRef, 'bootc', 'install', 'to-disk', '--generic-image', '--via-loopback', guestDisk,
  ].map(shellQuote).join(' ')
  await run(podman, ['machine', 'ssh', machineName, `${loadCommand} && ${buildCommand}`], { env: { ...process.env, ...podmanEnv } })
  await run(podman, ['machine', 'cp', `${machineName}:${guestDisk}`, rawDiskPath], { env: { ...process.env, ...podmanEnv } })

  const nextManifest = {
    ...manifest,
    disk: basename(rawDiskPath),
    diskBytes: (await stat(rawDiskPath)).size,
    diskBuiltAt: new Date().toISOString(),
  }
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ disk: rawDiskPath, fingerprint: manifest.fingerprint })}\n`)
} finally {
  if (builderWasCreated) await run(podman, ['machine', 'rm', '--force', machineName], { env: { ...process.env, ...podmanEnv } }).catch(() => undefined)
}
