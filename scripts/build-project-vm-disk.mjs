// Produce the bootable Project VM disk consumed by the runtime.
//
// The Containerfile build produces an OCI bootc image. OCI archives are not
// VM disks and must never be passed directly to `podman machine init`: on
// AppleHV that would copy the tar file to the raw-disk path and vfkit would
// immediately exit. This image-production step boots a temporary stock
// machine, applies the local OCI image with bootc, and publishes the resulting
// raw disk. Runtime startup only consumes that local disk and does no image
// build or registry pull.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'
import { run, runCapture } from './lib/podman-builder.mjs'
import { readProjectSupabaseLock } from './lib/project-supabase-lock.mjs'
import { nodeArchitecture, readImageArtifactManifest } from './lib/project-supabase-images.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
await configureBundledPodmanRuntime(root)

const podman = process.env.OPENLINK_PODMAN_COMMAND || resolve(root, '.openlink-runtime/toolchain/bin/podman')
const configRoot = process.env.XDG_CONFIG_HOME || resolve(root, '.openlink-runtime/podman-config')
const dataRoot = process.env.XDG_DATA_HOME || resolve(root, '.openlink-runtime/podman-data')
const provider = process.env.CONTAINERS_MACHINE_PROVIDER || 'applehv'
const outputRoot = resolve(root, '.openlink-runtime/project-vm-base')
const manifestPath = join(outputRoot, 'manifest.json')
const ociArchive = join(outputRoot, 'openlink-project-vm-base.oci.tar')
const machineName = process.env.OPENLINK_PROJECT_VM_IMAGE_MACHINE || `ol-vm-build-${process.pid}`
if (machineName.length > 30) throw new Error('OPENLINK_PROJECT_VM_IMAGE_MACHINE must be 30 characters or less')
const rawDiskName = `openlink-project-vm-base-${process.arch}.raw`
const rawDiskPath = join(outputRoot, rawDiskName)
const projectSupabaseLockPath = resolve(root, 'services/project-supabase/runtime.lock.json')
const projectSupabaseImageRoot = resolve(root, '.openlink-runtime/project-supabase/images', nodeArchitecture())
const projectSupabaseImageManifestPath = join(projectSupabaseImageRoot, 'manifest.json')
const guestOutputRoot = '/var/mnt/openlink-project-vm-base'
const guestProjectSupabaseImageRoot = '/var/mnt/openlink-project-supabase-images'
const guestStagingRoot = '/var/tmp/openlink-project-vm-output'
// podman/machine-os uses a dedicated /boot filesystem. bootc's opinionated
// to-disk demo layout only creates an ESP plus root, while the inherited
// Fedora/CoreOS bootloader configuration searches for the filesystem labelled
// `boot`. Keep the machine-compatible layout explicit and versioned so an
// already-published disk made by an older layout is never reused.
//
// /boot must remain readable by GRUB after a Project VM has been stopped or
// recovered. Use ext4 there (and retain XFS for root/data): GRUB can reliably
// consume the ext4 boot filesystem across repeated AppleHV power cycles,
// whereas the prior XFS /boot image failed before kernel handoff on its second
// start in local hardware validation.
const diskLayout = 'podman-machine-os-efi-boot-root-applehv-ignition-v6'
const diskSizeGb = Number.parseInt(process.env.OPENLINK_PROJECT_VM_IMAGE_DISK_GB || '64', 10)
if (!Number.isSafeInteger(diskSizeGb) || diskSizeGb < 16 || diskSizeGb > 1024) throw new Error('OPENLINK_PROJECT_VM_IMAGE_DISK_GB must be an integer between 16 and 1024')

const podmanEnv = {
  XDG_CONFIG_HOME: configRoot,
  XDG_DATA_HOME: dataRoot,
  CONTAINERS_MACHINE_PROVIDER: provider,
  CONTAINERS_HELPER_BINARY_DIR: process.env.CONTAINERS_HELPER_BINARY_DIR || resolve(root, '.openlink-runtime/toolchain/bin'),
  PATH: `${process.env.CONTAINERS_HELPER_BINARY_DIR || resolve(root, '.openlink-runtime/toolchain/bin')}:${process.env.PATH || ''}`,
}

const artifactOptions = { env: { ...process.env, ...podmanEnv }, timeout: 60 * 60 * 1000 }
const keepBuilderOnFailure = process.env.OPENLINK_KEEP_PROJECT_VM_IMAGE_BUILDER === '1'

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
    join(root, '.openlink-runtime/podman-data/containers/podman/machine', provider, 'cache'),
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
if (manifest.schemaVersion !== 2 || !manifest.projectSupabase) throw new Error('Project VM OCI image does not declare the required Project Supabase runtime')
const projectSupabaseLock = await readProjectSupabaseLock(projectSupabaseLockPath)
const projectSupabaseImages = await readImageArtifactManifest(projectSupabaseImageManifestPath, projectSupabaseLock)
const projectSupabaseImageManifestSha256 = createHash('sha256').update(await readFile(projectSupabaseImageManifestPath)).digest('hex')
if (projectSupabaseImages.architecture !== nodeArchitecture()) throw new Error('Project Supabase image artifacts do not match the Project VM disk architecture')
if (manifest.projectSupabase.release !== projectSupabaseLock.release.tag
  || manifest.projectSupabase.commit !== projectSupabaseLock.release.commit
  || manifest.projectSupabase.configurationTreeSha256 !== projectSupabaseLock.configuration.treeSha256) {
  throw new Error('Project VM OCI image Project Supabase metadata does not match the reviewed lock')
}
if (manifest.disk && typeof manifest.disk === 'string' && manifest.disk === rawDiskName) {
  const existingDisk = await stat(rawDiskPath).catch(() => null)
  if (existingDisk?.isFile()
    && existingDisk.size > 1024 * 1024
    && manifest.diskProjectSupabase?.release === projectSupabaseLock.release.tag
    && manifest.diskProjectSupabase?.commit === projectSupabaseLock.release.commit
    && manifest.diskProjectSupabase?.imageManifestSha256 === projectSupabaseImageManifestSha256
    && manifest.diskProjectSupabase?.images === projectSupabaseLock.services.length
    && manifest.diskLayout === diskLayout) {
    process.stdout.write(`${JSON.stringify({ disk: rawDiskPath, fingerprint: manifest.fingerprint, reused: true })}\n`)
    process.exit(0)
  }
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 })
let builderWasCreated = false
let stagingRoot
try {
  if (!(await machineExists())) {
    const cached = await cachedMachineOs()
    await run(podman, [
      'machine', 'init',
      ...(cached ? ['--image', cached] : []),
      '--rootful',
      '--cpus', process.env.OPENLINK_PROJECT_VM_IMAGE_CPUS || '4',
      '--memory', process.env.OPENLINK_PROJECT_VM_IMAGE_MEMORY_MB || '8192',
      '--disk-size', String(diskSizeGb),
      '--volume', `${outputRoot}:${guestOutputRoot}`,
      '--volume', `${projectSupabaseImageRoot}:${guestProjectSupabaseImageRoot}:ro`,
      machineName,
    ], artifactOptions)
    builderWasCreated = true
  }
  await run(podman, ['machine', 'start', machineName], artifactOptions).catch((error) => {
    if (!/already running|currently starting/i.test(error instanceof Error ? error.message : String(error))) throw error
  })
  await waitForSsh()

  const stagingName = `.disk-staging-${process.pid}-${randomBytes(6).toString('hex')}`
  stagingRoot = join(outputRoot, stagingName)
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  // Mount the latest seed script from the host into the seed container so the
  // Golden Disk is always seeded with the current working-tree code, even if
  // the OCI image was built from an earlier revision.  This picks up
  // seed-script fixes without a full OCI rebuild (which can exceed the SSH
  // command timeout on slow networks).  The OCI image's copy remains the
  // source of truth for the manifest hash.
  const seedScriptPath = resolve(root, 'services/agent-host/project-vm-seed-supabase.sh')
  await writeFile(resolve(outputRoot, 'project-vm-seed-supabase.sh'), await readFile(seedScriptPath), { mode: 0o755 })
  const temporaryRawDiskPath = join(stagingRoot, rawDiskName)
  const compressedDiskPath = join(stagingRoot, `${rawDiskName}.tar.gz`)
  const guestArchive = `${guestOutputRoot}/${basename(ociArchive)}`
  const guestOutput = `${guestStagingRoot}-${process.pid}-${randomBytes(6).toString('hex')}`
  const guestSupabaseImages = guestProjectSupabaseImageRoot
  const guestDisk = `${guestOutput}/${rawDiskName}`
  const guestCompressedDisk = `${guestOutput}/${rawDiskName}.tar.gz`
  const imageRef = `openlink/project-vm-base:${String(manifest.fingerprint).slice(0, 20)}`
  // Convert the local OCI image into a fresh bootable disk. This avoids
  // cloning a booted VM's machine-id, SSH host keys, or Podman state into
  // every Project. bootc-image-builder is intentionally not a runtime
  // dependency; the bootc tooling already present in the custom image does
  // the conversion in the disposable builder VM.
  const prepareGuestDisk = `${['sudo', 'mkdir', '-p', guestOutput].map(shellQuote).join(' ')} && ${['sudo', 'truncate', '-s', `${diskSizeGb}G`, guestDisk].map(shellQuote).join(' ')}`
  await run(podman, ['machine', 'ssh', machineName, prepareGuestDisk], artifactOptions)
  const loadCommand = ['sudo', 'podman', 'load', '-i', guestArchive].map(shellQuote).join(' ')
  const buildCommand = [
    'sudo', 'podman', 'run', '--rm', '--privileged', '--pid=host', '--ipc=host',
    '--security-opt', 'label=type:unconfined_t',
    '-v', '/dev:/dev', '-v', '/var/lib/containers:/var/lib/containers',
    '-v', `${guestOutput}:${guestOutput}`,
    // Pass the target disk path as an explicit environment variable instead of
    // a positional parameter.  The bootc-install script is a multi-line sh -ceu
    // program routed through `podman machine ssh`; positional parameters ($0/$1)
    // are not reliably preserved across the host→SSH→Podman→container chain
    // because the multi-line single-quoted script can interact with the SSH
    // command-string concatenation.  An --env flag is parsed by Podman itself
    // and is therefore immune to shell quoting ambiguity.
    '--env', `OPENLINK_GUEST_DISK=${guestDisk}`,
    imageRef,
    'sh', '-ceu', [
      'disk="${OPENLINK_GUEST_DISK:?OPENLINK_GUEST_DISK is required}"',
      'install_root=/var/mnt/openlink-project-vm-base/.openlink-install-root',
      'loop=',
      'mounted=0',
      'cleanup() { set +e; if [ "$mounted" = 1 ]; then umount "$install_root/boot/efi"; umount "$install_root/boot"; umount "$install_root"; fi; if [ -n "$loop" ]; then losetup -d "$loop"; fi; rm -rf "$install_root"; }',
      'trap cleanup EXIT',
      // crun mounts procfs mode 0755, while rustix-linux-procfs deliberately
      // rejects any /proc permission bits beyond 0555 before it exposes
      // /proc/self/fd to cap-tempfile.  Keep this correction inside the
      // disposable container mount namespace; the Builder VM is unchanged.
      'chmod 0555 /proc',
      'test "$(stat -Lc %a /proc)" = 555',
      'rm -rf "$install_root"',
      'mkdir -p "$install_root"',
      'loop=$(losetup --find --show --partscan "$disk")',
      'sfdisk --wipe always --wipe-partitions always "$loop" <<OPENLINK_PARTITIONS\nlabel: gpt\nfirst-lba: 2048\n2048 2048 8da63339-0007-60c0-c436-083ac8230908\n4096 260096 c12a7328-f81f-11d2-ba4b-00a0c93ec93b\n264192 1048576 0fc63daf-8483-4772-8e79-3d69d8477de4\n1312768 - 0fc63daf-8483-4772-8e79-3d69d8477de4\nOPENLINK_PARTITIONS',
      'losetup -d "$loop"',
      'loop=',
      'udevadm settle || true',
      'loop=$(losetup --find --show --partscan "$disk")',
      'partition_prefix="${loop}p"',
      'efi_partition="${partition_prefix}2"',
      'boot_partition="${partition_prefix}3"',
      'root_partition="${partition_prefix}4"',
      'for partition in "$efi_partition" "$boot_partition" "$root_partition"; do test -b "$partition" || { echo "missing partition $partition" >&2; exit 1; }; done',
      // The disk layout is a release contract.  Fail before mutating any
      // partition when an older/custom base image lacks the ext4 formatter;
      // do not silently fall back to an unsupported /boot filesystem.
      'command -v mkfs.ext4 >/dev/null || { echo "mkfs.ext4 is required for the Project VM boot filesystem" >&2; exit 1; }',
      'mkfs.fat -F 32 -n EFI-SYSTEM "$efi_partition"',
      'mkfs.ext4 -F -L boot "$boot_partition"',
      'mkfs.xfs -f -L root "$root_partition"',
      'mount "$root_partition" "$install_root"',
      'mounted=1',
      'mkdir -p "$install_root/boot"',
      'mount "$boot_partition" "$install_root/boot"',
      'mkdir -p "$install_root/boot/efi"',
      'mount "$efi_partition" "$install_root/boot/efi"',
      'ls -ld "$install_root" "$install_root/boot" "$install_root/boot/efi"',
      'root_uuid=$(blkid -s UUID -o value "$root_partition")',
      'boot_uuid=$(blkid -s UUID -o value "$boot_partition")',
      'test -n "$root_uuid" && test -n "$boot_uuid"',
      'bootc install to-filesystem --generic-image --karg=ignition.firstboot --karg=ignition.platform.id=applehv --karg=rd.neednet=1 --karg=ip=dhcp --root-mount-spec=UUID=$root_uuid --boot-mount-spec=UUID=$boot_uuid "$install_root"',
      // FCOS GRUB derives the first-boot kargs (including rd.neednet=1 and
      // ip=dhcp) from this marker on the dedicated boot filesystem.  A bootc
      // OCI deployment does not carry the stock machine-os marker across the
      // to-filesystem conversion, so recreate it after bootc populated /boot.
      'chattr -i "$install_root" "$install_root/boot" "$install_root/boot/efi" || true',
      'mount -o remount,rw "$root_partition" "$install_root" || true',
      'mount -o remount,rw "$boot_partition" "$install_root/boot" || true',
      'printf "%s\\n" "set ignition_network_kcmdline=\'rd.neednet=1 ip=dhcp\'" > "$install_root/boot/ignition.firstboot"',
      'sync',
      'umount "$install_root/boot/efi"',
      'umount "$install_root/boot"',
      'umount "$install_root"',
      'mounted=0',
      'losetup -d "$loop"',
      'loop=',
    ].join('\n'),
  ].map(shellQuote).join(' ')
  const seedCommand = [
    'sudo', 'podman', 'run', '--rm', '--privileged', '--pid=host', '--ipc=host',
    '--security-opt', 'label=type:unconfined_t',
    '-v', '/dev:/dev',
    '-v', `${guestOutput}:${guestOutput}`,
    '-v', `${guestSupabaseImages}:${guestSupabaseImages}:ro`,
    '-v', `${guestOutputRoot}/project-vm-seed-supabase.sh:/tmp/project-vm-seed-supabase.sh:ro`,
    imageRef,
    'bash', '/tmp/project-vm-seed-supabase.sh', guestDisk, guestSupabaseImages,
  ].map(shellQuote).join(' ')
  await run(podman, ['machine', 'ssh', machineName, `${loadCommand} && ${buildCommand} && ${seedCommand}`], artifactOptions)
  const compressCommand = ['sudo', 'tar', '--sparse', '-C', guestOutput, '-czf', guestCompressedDisk, rawDiskName].map(shellQuote).join(' ')
  await run(podman, ['machine', 'ssh', machineName, compressCommand], artifactOptions)
  await run(podman, ['machine', 'cp', `${machineName}:${guestCompressedDisk}`, compressedDiskPath], artifactOptions)
  if (builderWasCreated) {
    await run(podman, ['machine', 'rm', '--force', machineName], artifactOptions)
    builderWasCreated = false
  }
  // macOS ships only BSD libarchive tar, which materialises GNU sparse holes
  // as explicit zero bytes on extraction. A 64 GiB Golden Disk that carries
  // ~9 GiB of real data would therefore be published as a 64 GiB thick file,
  // exhausting the host volume and defeating the copy-on-write clone the
  // runtime depends on. The bundled Python helper parses the GNU sparse 1.0
  // extent map, streams only the packed real-data extents (holes are never
  // read), and ftruncate-pre-sizes the destination so APFS keeps the file
  // genuinely sparse — exactly what clonefile(2) later requires.
  const sparseExtractor = resolve(root, 'scripts/lib/extract-sparse-disk.py')
  await run('python3', [sparseExtractor, compressedDiskPath, rawDiskName, temporaryRawDiskPath], artifactOptions)
  await rm(compressedDiskPath, { force: true })
  const temporaryDisk = await stat(temporaryRawDiskPath)
  if (!temporaryDisk.isFile() || temporaryDisk.size < 1024 * 1024) throw new Error('Project VM Golden Disk staging artifact is invalid')
  await rename(temporaryRawDiskPath, rawDiskPath)
  await rm(stagingRoot, { recursive: true, force: true })
  stagingRoot = undefined

  const nextManifest = {
    ...manifest,
    disk: basename(rawDiskPath),
    diskBytes: (await stat(rawDiskPath)).size,
    diskBuiltAt: new Date().toISOString(),
    diskProjectSupabase: {
      release: projectSupabaseLock.release.tag,
      commit: projectSupabaseLock.release.commit,
      architecture: projectSupabaseImages.architecture,
      imageManifestSha256: projectSupabaseImageManifestSha256,
      images: projectSupabaseImages.images.length,
      preloaded: true,
    },
    diskLayout,
    diskFilesystem: 'boot-ext4-root-xfs',
  }
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ disk: rawDiskPath, fingerprint: manifest.fingerprint })}\n`)
} finally {
  if (stagingRoot && !keepBuilderOnFailure) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  if (builderWasCreated && !keepBuilderOnFailure) await run(podman, ['machine', 'rm', '--force', machineName], { env: { ...process.env, ...podmanEnv } }).catch(() => undefined)
}
