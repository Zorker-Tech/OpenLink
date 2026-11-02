#!/usr/bin/env node
// Build the immutable Ubuntu Project VM base used by T1.
//
// The Project VM userspace is the pinned Ubuntu 24.04 LTS desktop image. It
// contains Ubuntu GNOME 46 (X11 backend), Xvfb, x11vnc, websockify and the
// desktop runtime. This builder adds the Project VM runtime (rootful Podman,
// SSH, cloud-init, network and netfilter tools), the pinned Node runtime, a
// verified Ubuntu LTS generic kernel/initrd/modules, and turns the result into
// a bootable ext4/qcow2 disk. T1 requires GNOME: it does not silently fall back
// to a lightweight desktop.
//
// The kernel and initrd are passed directly to QEMU (`-kernel`/`-initrd`), so
// the Project VM does not depend on a bootloader, an ISO installer or a
// network package install at boot. The root filesystem is `/dev/vda`.
//
// Requirements: Linux, Docker with the local `openlink/agent-worker:dev`
// image, qemu-img, sfdisk, dd and debugfs. No KVM is required to build; KVM is
// required to run T1.
//
// Output (content-addressed, immutable):
//   .openlink-runtime/project-vm-base/ubuntu/
//     ubuntu-project-vm-base-<sha>.qcow2
//     vmlinuz-<kernel>
//     initrd.img-<kernel>
//     manifest.json

import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(new URL('..', import.meta.url).pathname)
const cacheRoot = resolve(process.env.OPENLINK_UBUNTU_CLOUD_CACHE || resolve(homedir(), '.cache/openlink/ubuntu-cloud'))
const cloudImageUrl = process.env.OPENLINK_UBUNTU_CLOUD_IMAGE_URL?.trim()
  || 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img'
const cloudImage = resolve(cacheRoot, basename(cloudImageUrl))
const projectVmProfile = (process.env.OPENLINK_UBUNTU_PROJECT_VM_PROFILE
  || process.env.OPENLINK_ARCHITECTURE
  || 't1').trim().toLowerCase()
if (projectVmProfile !== 't1' && projectVmProfile !== 't2') throw new Error('OPENLINK_UBUNTU_PROJECT_VM_PROFILE must be t1 or t2')
const isT2 = projectVmProfile === 't2'
const outputRoot = resolve(process.env.OPENLINK_UBUNTU_PROJECT_VM_OUTPUT
  || resolve(root, `.openlink-runtime/project-vm-base/${isT2 ? 't2' : 'ubuntu'}`))
const docker = process.env.OPENLINK_DOCKER_COMMAND?.trim() || 'docker'
const workerImage = process.env.OPENLINK_AGENT_WORKER_IMAGE?.trim() || 'openlink/agent-worker:dev'
// T1 is pinned to Ubuntu 24.04 LTS + GNOME 46 X11. T2 is the preview line on
// the latest Ubuntu 26.10 userspace with GNOME 51 Wayland and an RDP bridge.
const usersImage = process.env.OPENLINK_UBUNTU_USERS_IMAGE?.trim() || (isT2 ? workerImage : 'ubuntu:24.04')
const imageArchive = resolve(process.env.OPENLINK_AGENT_WORKER_ARCHIVE?.trim()
  || resolve(homedir(), '.cache/openlink/project-images/openlink_agent-worker_dev.tar'))
const projectSupabaseCache = resolve(process.env.OPENLINK_PROJECT_SUPABASE_CACHE || resolve(root, '.openlink-runtime/project-supabase/cache'))
const projectSupabaseBundle = resolve(process.env.OPENLINK_PROJECT_SUPABASE_BUNDLE_ARCHIVE || resolve(projectSupabaseCache, 'bundle.tar'))
const projectSupabaseImages = resolve(process.env.OPENLINK_PROJECT_SUPABASE_IMAGES_ARCHIVE || resolve(projectSupabaseCache, 'images.tar'))
const diskGb = Number(process.env.OPENLINK_UBUNTU_PROJECT_VM_DISK_GB || 64)
const chromeDebUrl = 'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.79-1_amd64.deb'
const chromeDebSha256 = 'be1a1e161419f5c8272432f6860912550d8e29985e925913fa800493a0d0c955'
const agentDesktopReleaseUrl = 'https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-x86_64-unknown-linux-gnu.tar.gz'
const agentDesktopReleaseSha256 = 'ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4'
const guestPackages = [
  'openssh-server',
  'podman',
  'iproute2',
  'iptables',
  'nftables',
  'sudo',
  'systemd-resolved',
  'cloud-init',
  'conntrack',
  'kmod',
  'curl',
  'jq',
  'git',
  'ca-certificates',
  'procps',
  'psmisc',
  'tar',
  'gzip',
  'xz-utils',
  // Podman's netavark backend resolves container names through aardvark-dns.
  // Ubuntu does not install it as a hard dependency, and without it every
  // inter-service lookup (for example auth -> db) times out at 10.89.0.1:53.
  'aardvark-dns',
  // Ubuntu's GNOME session. GNOME 46 supports the X11 backend, which is the
  // only backend available under Xvfb; newer GNOME releases are Wayland-only.
  'ubuntu-desktop-minimal',
  'ubuntu-session',
  'gnome-session',
  'gnome-shell',
  'gnome-shell-ubuntu-extensions',
  'gnome-terminal',
  'nautilus',
  'gnome-settings-daemon',
  'polkitd',
  'xdg-user-dirs',
  'xvfb',
  'x11vnc',
  'websockify',
  'novnc',
  'dbus-user-session',
  'dbus-x11',
  'x11-utils',
  'xauth',
  'x11-xserver-utils',
  'fonts-ubuntu',
  'fonts-noto-color-emoji',
  ...(isT2 ? [
    // T2 preview: Wayland GNOME Shell is captured through GNOME Remote
    // Desktop's RDP server and bridged back to the existing VNC gateway.
    'gnome-remote-desktop',
    'freerdp3-x11',
    'dbus-user-session',
    'gnome-keyring',
    'libsecret-tools',
    'openssl',
  ] : []),
]

function log(message) {
  process.stdout.write(`[ubuntu-project-vm] ${message}\n`)
}

function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', rejectHash)
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function run(file, args, options = {}) {
  return execFile(file, args, {
    timeout: options.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
    cwd: options.cwd,
  })
}

async function downloadCloudImage() {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  let expected
  const checksumsUrl = cloudImageUrl.replace(/[^/]+$/, 'SHA256SUMS')
  let checksumError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(checksumsUrl, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const sums = await response.text()
      const line = sums.split('\n').find((item) => {
        const value = item.trim()
        return value.endsWith(`*${basename(cloudImageUrl)}`) || value.endsWith(` ${basename(cloudImageUrl)}`)
      })
      expected = line?.trim().split(/\s+/)[0]
      checksumError = undefined
      break
    } catch (error) {
      checksumError = error
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 2_000))
    }
  }
  const checksumSidecar = `${cloudImage}.sha256`
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '') && existsSync(checksumSidecar)) {
    const cached = (await readFile(checksumSidecar, 'utf8')).trim()
    if (/^[a-f0-9]{64}$/i.test(cached)) {
      expected = cached
      log('using the cached Ubuntu cloud image checksum after a manifest fetch failure')
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) {
    throw new Error(`Ubuntu cloud image checksum manifest is unavailable: ${checksumError instanceof Error ? checksumError.message : String(checksumError)}`)
  }
  if (existsSync(cloudImage)) {
    const actual = await sha256(cloudImage)
    if (actual === expected) {
      await writeFile(checksumSidecar, `${actual}\n`, { mode: 0o600 })
      return { path: cloudImage, sha256: actual }
    }
    log('cached cloud image checksum differs; downloading a fresh copy')
  }
  const partial = `${cloudImage}.partial-${process.pid}`
  await rm(partial, { force: true })
  log(`downloading ${cloudImageUrl}`)
  const response = await fetch(cloudImageUrl, { signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Ubuntu cloud image download failed (HTTP ${response.status})`)
  const hash = createHash('sha256')
  const check = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.from(response.body), check, createWriteStream(partial, { mode: 0o600 }))
  const actual = hash.digest('hex')
  if (actual !== expected) {
    await rm(partial, { force: true })
    throw new Error('Ubuntu cloud image SHA-256 verification failed')
  }
  await rename(partial, cloudImage)
  await chmod(cloudImage, 0o600)
  await writeFile(`${cloudImage}.sha256`, `${actual}\n`, { mode: 0o600 })
  return { path: cloudImage, sha256: actual }
}

async function downloadPinnedFile(url, expectedSha256, label) {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const path = resolve(cacheRoot, basename(url))
  if (existsSync(path) && await sha256(path) === expectedSha256) return path
  const partial = `${path}.partial-${process.pid}`
  await rm(partial, { force: true })
  log(`downloading ${label}`)
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`${label} download failed (HTTP ${response.status})`)
  const hash = createHash('sha256')
  const check = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.from(response.body), check, createWriteStream(partial, { mode: 0o600 }))
  const actual = hash.digest('hex')
  if (actual !== expectedSha256) {
    await rm(partial, { force: true })
    throw new Error(`${label} SHA-256 verification failed`)
  }
  await rename(partial, path)
  await chmod(path, 0o600)
  return path
}

async function extractPartitions(rawDisk, workRoot) {
  const table = await run('sfdisk', ['-d', rawDisk], { timeout: 30_000 })
  const partitions = []
  for (const line of table.stdout.split('\n')) {
    const match = /: start=\s*(\d+),\s*size=\s*(\d+),/.exec(line)
    if (match) partitions.push({ start: Number(match[1]), size: Number(match[2]) })
  }
  if (!partitions.length) throw new Error('Ubuntu cloud image partition table is empty')
  const extracted = []
  for (let index = 0; index < partitions.length; index += 1) {
    const { start, size } = partitions[index]
    if (size * 512 < 4 * 1024 * 1024) continue
    const path = resolve(workRoot, `part-${index}.ext4`)
    await run('dd', [`if=${rawDisk}`, `of=${path}`, 'bs=512', `skip=${start}`, `count=${size}`, 'status=none'], { timeout: 10 * 60_000 })
    try {
      const listing = await run('debugfs', ['-R', 'ls -l /', path], { timeout: 30_000 })
      extracted.push({ index, path, listing: listing.stdout })
    } catch {
      await rm(path, { force: true })
    }
  }
  return extracted
}

function pickKernel(bootListing) {
  const kernelLine = bootListing.split('\n').find((line) => /\bvmlinuz-\d/.test(line))
  const initrdLine = bootListing.split('\n').find((line) => /\binitrd\.img-\d/.test(line))
  const kernel = kernelLine && /(vmlinuz-\S+)/.exec(kernelLine)?.[1]
  const initrd = initrdLine && /(initrd\.img-\S+)/.exec(initrdLine)?.[1]
  if (!kernel || !initrd) return undefined
  return { kernel, initrd, version: kernel.slice('vmlinuz-'.length) }
}

let workRoot = ''
let rootfsContainer = ''
try {
  try {
    await run(docker, ['image', 'inspect', workerImage], { timeout: 30_000 })
  } catch {
    if (!existsSync(imageArchive)) throw new Error(`Docker image ${workerImage} is missing and no archive exists at ${imageArchive}`)
    log(`loading ${workerImage}`)
    await run(docker, ['load', '-i', imageArchive], { timeout: 15 * 60_000 })
  }
  const cloud = await downloadCloudImage()
  for (const [label, path] of [['Project Supabase bundle', projectSupabaseBundle], ['Project Supabase images', projectSupabaseImages]]) {
    const metadata = await stat(path).catch(() => undefined)
    if (!metadata?.isFile() || metadata.size <= 0) throw new Error(`${label} archive is missing: ${path}`)
  }
  workRoot = resolve(outputRoot, `.build-${process.pid}-${randomBytes(4).toString('hex')}`)
  await mkdir(workRoot, { recursive: true, mode: 0o700 })

  log('extracting the Ubuntu LTS generic kernel, initrd and modules from the verified cloud image')
  const rawCloud = resolve(workRoot, 'cloud.raw')
  await run('qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', cloud.path, rawCloud], { timeout: 10 * 60_000 })
  const partitions = await extractPartitions(rawCloud, workRoot)
  let boot
  let rootPartition
  for (const partition of partitions) {
    const candidate = pickKernel(partition.listing)
    if (candidate) boot = { ...candidate, path: partition.path }
    if (/^.*\betc$/m.test(partition.listing) && /^.*\blib$/m.test(partition.listing)) rootPartition ??= partition
  }
  if (!boot || !rootPartition) throw new Error('Ubuntu cloud image kernel/root partitions were not recognized')
  const kernelPath = resolve(workRoot, boot.kernel)
  const initrdPath = resolve(workRoot, boot.initrd)
  await run('debugfs', ['-R', `dump /${boot.kernel} ${kernelPath}`, boot.path], { timeout: 60_000 })
  await run('debugfs', ['-R', `dump /${boot.initrd} ${initrdPath}`, boot.path], { timeout: 60_000 })
  const modulesPath = resolve(workRoot, 'modules')
  await mkdir(modulesPath, { recursive: true })
  await run('debugfs', ['-R', `rdump /lib/modules ${modulesPath}`, rootPartition.path], { timeout: 5 * 60_000 })
  if (!existsSync(resolve(modulesPath, 'modules', boot.version))) {
    throw new Error(`Ubuntu cloud image modules do not match kernel ${boot.version}`)
  }
  log(`using kernel ${boot.version}`)

  rootfsContainer = `openlink-t1-rootfs-${process.pid}-${randomBytes(3).toString('hex')}`
  log(`installing the Ubuntu Project VM userspace from ${usersImage}`)
  const aptMirror = process.env.OPENLINK_UBUNTU_APT_MIRROR?.trim() || ''
  if (aptMirror && !/^https?:\/\/[^\s|\\]+$/.test(aptMirror)) throw new Error('OPENLINK_UBUNTU_APT_MIRROR is invalid')
  const aptUpdate = process.env.OPENLINK_UBUNTU_APT_UPDATE !== '0'
  try {
    await run(docker, ['image', 'inspect', usersImage], { timeout: 30_000 })
  } catch {
    log(`pulling ${usersImage}`)
    await run(docker, ['pull', usersImage], { timeout: 30 * 60_000 })
  }
  await run(docker, [
    'run', '--detach', '--name', rootfsContainer, '--entrypoint', 'sleep', usersImage, 'infinity',
  ], { timeout: 60_000 })
  const chromeDeb = await downloadPinnedFile(chromeDebUrl, chromeDebSha256, 'Google Chrome package')
  const agentDesktopArchive = await downloadPinnedFile(agentDesktopReleaseUrl, agentDesktopReleaseSha256, 'agent-desktop release')
  await run(docker, ['cp', chromeDeb, `${rootfsContainer}:/tmp/google-chrome.deb`], { timeout: 120_000 })
  await run(docker, ['cp', agentDesktopArchive, `${rootfsContainer}:/tmp/agent-desktop.tar.gz`], { timeout: 120_000 })
  await run(docker, ['exec', rootfsContainer, 'mkdir', '-p', '/usr/share/doc/agent-desktop'], { timeout: 30_000 })
  await run(docker, ['cp', resolve(root, 'services/agent-desktop/LICENSE'), `${rootfsContainer}:/usr/share/doc/agent-desktop/LICENSE`], { timeout: 60_000 })
  await run(docker, [
    'exec', rootfsContainer, 'bash', '-lc', [
      'set -e',
      'export DEBIAN_FRONTEND=noninteractive',
      ...(aptMirror ? [
        `sed -i 's|http://archive.ubuntu.com/ubuntu/|${aptMirror}|g; s|http://security.ubuntu.com/ubuntu/|${aptMirror}|g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true`,
      ] : []),
      // Build hosts with IPv6 DNS but no IPv6 route make apt's http method
      // stall indefinitely on AAAA answers. Pin the artifact build to IPv4 and
      // retry transient mirror failures so it is reproducible.
      'APT_OPTIONS="-o Acquire::ForceIPv4=true -o Acquire::Retries=5"',
      ...(aptUpdate ? ['apt-get $APT_OPTIONS update -qq'] : []),
      `apt-get $APT_OPTIONS install -y -qq --no-install-recommends ${guestPackages.join(' ')} >/dev/null`,
      'apt-get $APT_OPTIONS install -y -qq /tmp/google-chrome.deb >/dev/null',
      'tar -xzf /tmp/agent-desktop.tar.gz -C /usr/local/bin',
      'chmod 0755 /usr/local/bin/agent-desktop /usr/local/bin/agent-desktop-linux-clipboard-owner',
      'rm -f /tmp/google-chrome.deb /tmp/agent-desktop.tar.gz',
      // The Ubuntu cloud image has a default `ubuntu` user at UID 1000. The
      // Project VM contract is the `openlink` user at UID 1000; replace it so
      // cloud-init and the desktop services share one identity.
      'if getent passwd ubuntu >/dev/null 2>&1; then userdel -r ubuntu >/dev/null 2>&1 || userdel ubuntu >/dev/null 2>&1 || true; fi',
      'if ! getent passwd openlink >/dev/null 2>&1; then useradd -m -u 1000 -G sudo,adm -s /bin/bash openlink; fi',
      ...(isT2 ? ['usermod -aG render openlink'] : []),
      'echo "openlink ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/openlink',
      'chmod 0440 /etc/sudoers.d/openlink',
      'mkdir -p /home/openlink && chown openlink:openlink /home/openlink',
      'rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/lib/cloud/* /home/openlink/.ssh /root/.ssh',
    ].join('\n'),
  ], { timeout: 60 * 60_000 })

  // Node is pinned in the worker image; copy only the runtime binary. The
  // guest does not need npm for project services or the Supabase controller.
  log('installing the pinned Node runtime into the Project VM userspace')
  const nodeContainer = `openlink-t1-node-${process.pid}-${randomBytes(3).toString('hex')}`
  const nodeBinary = resolve(workRoot, 'node')
  await run(docker, ['create', '--name', nodeContainer, workerImage], { timeout: 60_000 })
  try {
    await run(docker, ['cp', `${nodeContainer}:/usr/local/bin/node`, nodeBinary], { timeout: 120_000 })
  } finally {
    await run(docker, ['rm', '-f', nodeContainer], { timeout: 60_000 }).catch(() => undefined)
  }
  await run(docker, ['exec', rootfsContainer, 'mkdir', '-p', '/usr/local/bin', '/opt/openlink/desktop'], { timeout: 30_000 })
  await run(docker, ['cp', nodeBinary, `${rootfsContainer}:/usr/local/bin/node`], { timeout: 120_000 })
  const desktopCopies = isT2
    ? [['start-wayland.sh', 'start.sh']]
    : [['start.sh', 'start.sh'], ['run-ubuntu-vm.sh', 'run-ubuntu-vm.sh'], ['qmp-control.py', 'qmp-control.py']]
  for (const [source, destination] of desktopCopies) {
    await run(docker, ['cp', resolve(root, 'services/agent-worker/desktop', source), `${rootfsContainer}:/opt/openlink/desktop/${destination}`], { timeout: 60_000 })
  }
  // The real agent-desktop binary stays on the Project VM host. The session
  // container receives a small Unix-socket client and a constrained bridge
  // socket, because its PID namespace cannot inspect the host desktop.
  await run(docker, ['cp', resolve(root, 'services/agent-worker/desktop/desktop-tool-bridge.mjs'), `${rootfsContainer}:/opt/openlink/desktop/desktop-tool-bridge.mjs`], { timeout: 60_000 })
  await run(docker, ['cp', resolve(root, 'services/agent-worker/desktop/openlink-agent-desktop.mjs'), `${rootfsContainer}:/usr/local/bin/openlink-agent-desktop`], { timeout: 60_000 })
  await run(docker, ['exec', rootfsContainer, 'chmod', '0755', '/usr/local/bin/openlink-agent-desktop'], { timeout: 30_000 })
  if (isT2) {
    // The headless session must hide GNOME's screen-sharing indicator: in T2
    // the RDP surface is the only display, and the indicator's stop action
    // turns the user's desktop black.
    const extensionSource = resolve(root, 'services/agent-worker/desktop/gnome-extensions/openlink-headless@openlink')
    const extensionTarget = '/opt/openlink/desktop/gnome-extensions/openlink-headless@openlink'
    await run(docker, ['exec', rootfsContainer, 'mkdir', '-p', extensionTarget], { timeout: 30_000 })
    for (const file of ['metadata.json', 'extension.js']) {
      await run(docker, ['cp', resolve(extensionSource, file), `${rootfsContainer}:${extensionTarget}/${file}`], { timeout: 60_000 })
    }
    await run(docker, ['exec', rootfsContainer, 'chmod', '-R', 'a+rX', '/opt/openlink/desktop/gnome-extensions'], { timeout: 30_000 })
  }

  // Bash the product wallpaper set into the image. The GNOME XML pairs the
  // light and dark 4K variants, and the start script selects them explicitly
  // so a fresh project does not depend on the worker image's default.
  const wallpaperSource = resolve(root, 'services/agent-worker/desktop/wallpapers/astreusn-ubuntu')
  const wallpaperTarget = '/usr/share/backgrounds/astreusn'
  await run(docker, ['exec', rootfsContainer, 'mkdir', '-p', wallpaperTarget, '/usr/share/gnome-background-properties', '/usr/share/doc/openlink-wallpapers'], { timeout: 30_000 })
  for (const file of await readdir(wallpaperSource)) {
    if (!file.endsWith('.png')) continue
    await run(docker, ['cp', resolve(wallpaperSource, file), `${rootfsContainer}:${wallpaperTarget}/${file}`], { timeout: 120_000 })
  }
  await run(docker, ['cp', resolve(wallpaperSource, 'astreusn.xml'), `${rootfsContainer}:/usr/share/gnome-background-properties/astreusn.xml`], { timeout: 60_000 })
  await run(docker, ['cp', resolve(wallpaperSource, 'README.md'), `${rootfsContainer}:/usr/share/doc/openlink-wallpapers/README.md`], { timeout: 60_000 })
  await run(docker, ['exec', rootfsContainer, 'chmod', '-R', 'a+rX', wallpaperTarget, '/usr/share/gnome-background-properties/astreusn.xml', '/usr/share/doc/openlink-wallpapers'], { timeout: 30_000 })

  await run(docker, ['exec', rootfsContainer, 'sh', '-c', `chmod 0755 /usr/local/bin/node /opt/openlink/desktop/start.sh${isT2 ? '' : ' /opt/openlink/desktop/run-ubuntu-vm.sh'}`], { timeout: 30_000 })

  // Fail the artifact build before publishing if any first-run dependency is
  // missing. A project must never boot into a half-composed desktop.
  const requiredFiles = [
    '/usr/bin/google-chrome-stable',
    '/usr/share/applications/google-chrome.desktop',
    '/usr/local/bin/agent-desktop',
    '/usr/local/bin/agent-desktop-linux-clipboard-owner',
    '/usr/share/doc/agent-desktop/LICENSE',
    '/opt/openlink/desktop/start.sh',
    '/usr/share/backgrounds/astreusn/astreusn-ubuntu-light-3840x2160.png',
    '/usr/share/backgrounds/astreusn/astreusn-ubuntu-dark-3840x2160.png',
    '/usr/share/gnome-background-properties/astreusn.xml',
    '/usr/local/bin/openlink-agent-desktop',
    '/opt/openlink/desktop/desktop-tool-bridge.mjs',
    ...(isT2 ? [
      '/opt/openlink/desktop/gnome-extensions/openlink-headless@openlink/metadata.json',
      '/opt/openlink/desktop/gnome-extensions/openlink-headless@openlink/extension.js',
    ] : []),
  ]
  for (const path of requiredFiles) {
    await run(docker, ['exec', rootfsContainer, 'test', '-e', path], { timeout: 30_000 })
  }
  await run(docker, ['exec', rootfsContainer, 'google-chrome-stable', '--version'], { timeout: 60_000 })
  const agentDesktop = await run(docker, ['exec', rootfsContainer, 'agent-desktop', 'version'], { timeout: 60_000 })
  if (!agentDesktop.stdout.includes('"version":"1.0.2"')) throw new Error('agent-desktop release version check failed')
  log('verified Chrome, agent-desktop, wallpapers and the desktop runtime')

  const rootfsTar = resolve(workRoot, 'rootfs.tar')
  await run(docker, ['export', rootfsContainer, '-o', rootfsTar], { timeout: 30 * 60_000 })
  await run(docker, ['rm', '-f', rootfsContainer], { timeout: 60_000 })
  rootfsContainer = ''

  const configScript = `set -e
export DEBIAN_FRONTEND=noninteractive
rm -rf /rootfs
mkdir -p /rootfs
tar -xf /work/rootfs.tar -C /rootfs
mkdir -p /rootfs/boot /rootfs/lib/modules
cp /work/${boot.kernel} /rootfs/boot/${boot.kernel}
cp /work/${boot.initrd} /rootfs/boot/${boot.initrd}
cp -a /work/modules/modules/${boot.version} /rootfs/lib/modules/

# The desktop service starts the systemd user manager explicitly; enabling
# linger also makes it available immediately after boot for GNOME's session
# targets and user D-Bus.
mkdir -p /rootfs/var/lib/systemd/linger
touch /rootfs/var/lib/systemd/linger/openlink

# A Project VM is an appliance; never prompt for an Ubuntu release upgrade.
mkdir -p /rootfs/etc/update-manager
cat >/rootfs/etc/update-manager/release-upgrades <<'OPENLINK_RELEASE_UPGRADES'
[DEFAULT]
Prompt=never
OPENLINK_RELEASE_UPGRADES
rm -f /rootfs/etc/xdg/autostart/update-notifier.desktop

# T2 runs a Wayland-only GNOME session. The worker userspace also carries the
# E1 Xfce/X11 tools; hide their launchers so the Ubuntu application grid does
# not offer applications that cannot run under --no-x11.
for desktop_file in \
  /rootfs/usr/share/applications/debian-xterm.desktop \
  /rootfs/usr/share/applications/debian-uxterm.desktop \
  /rootfs/usr/share/applications/thunar*.desktop \
  /rootfs/usr/share/applications/xfce*.desktop \
  /rootfs/usr/share/applications/xfreerdp.desktop \
  /rootfs/usr/share/applications/x11vnc.desktop; do
  if [ -f "$desktop_file" ]; then
    # Desktop files may contain action groups after [Desktop Entry]. Mark the
    # main entry, not the last action group, as hidden.
    sed -i '0,/^\[Desktop Entry\]/s//[Desktop Entry]\\nNoDisplay=true/' "$desktop_file"
  fi
done

# Chrome is preinstalled for both desktop profiles. Skip the first-run/default
# browser prompts; T2 additionally needs the Wayland ozone backend because it
# runs with --no-x11.
if [ -f /rootfs/usr/share/applications/google-chrome.desktop ]; then
  sed -i 's|^Exec=/usr/bin/google-chrome-stable|Exec=/usr/bin/google-chrome-stable --no-first-run --disable-default-browser-check|' /rootfs/usr/share/applications/google-chrome.desktop
  if [ "${isT2 ? '1' : '0'}" = "1" ]; then
    sed -i 's|^Exec=/usr/bin/google-chrome-stable|Exec=/usr/bin/google-chrome-stable --ozone-platform=wayland --enable-features=WaylandWindowDecorations --password-store=basic|' /rootfs/usr/share/applications/google-chrome.desktop
  fi
fi

mkdir -p /rootfs/etc/systemd/network
cat >/rootfs/etc/systemd/network/20-wired.network <<'OPENLINK_NETWORK'
[Match]
Name=en*
Name=eth*
[Network]
DHCP=yes
OPENLINK_NETWORK

mkdir -p /rootfs/etc/systemd/system
cat >/rootfs/etc/systemd/system/openlink-desktop.service <<'OPENLINK_DESKTOP'
[Unit]
Description=OpenLink project native desktop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=OPENLINK_DESKTOP_MODE=${isT2 ? 'wayland-rdp' : 'ubuntu-container'}
Environment=OPENLINK_DESKTOP_REQUIRE_GNOME=1
ExecStart=/bin/bash /opt/openlink/desktop/start.sh
Restart=always
RestartSec=2
# A compositor child can ignore SIGTERM after the session crashes. Bound the
# graceful-stop window so systemd SIGKILLs the cgroup and restarts the desktop
# instead of leaving the endpoint unavailable for the default 90 seconds.
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
OPENLINK_DESKTOP

mkdir -p /rootfs/etc/systemd/system/ssh.service.d
mkdir -p /rootfs/etc/systemd/system/var-lib-cloud-seed-nocloud.mount.d
cat >/rootfs/etc/systemd/system/var-lib-cloud-seed-nocloud.mount.d/10-openlink-before-cloud-init.conf <<'OPENLINK_SEED_MOUNT'
[Unit]
DefaultDependencies=no
Before=cloud-init-local.service
After=dev-vdb.device
OPENLINK_SEED_MOUNT

cat >/rootfs/etc/systemd/system/ssh.service.d/10-openlink-host-keys.conf <<'OPENLINK_SSH_DROPIN'
[Service]
ExecStartPre=
ExecStartPre=/usr/bin/ssh-keygen -A
ExecStartPre=/usr/sbin/sshd -t
OPENLINK_SSH_DROPIN

mkdir -p /rootfs/etc/ssh/sshd_config.d
cat >/rootfs/etc/ssh/sshd_config.d/90-openlink.conf <<'OPENLINK_SSHD'
PasswordAuthentication no
PermitRootLogin no
OPENLINK_SSHD

printf '%s\\n' 'openlink ALL=(ALL) NOPASSWD:ALL' >/rootfs/etc/sudoers.d/90-openlink
chmod 0440 /rootfs/etc/sudoers.d/90-openlink

cat >/rootfs/etc/fstab <<'OPENLINK_FSTAB'
/dev/vda / ext4 defaults,noatime 0 1
/dev/vdb /var/lib/cloud/seed/nocloud ext4 defaults,ro,nofail 0 0
tmpfs /tmp tmpfs mode=1777 0 0
OPENLINK_FSTAB
printf '%s\\n' 'openlink-project' >/rootfs/etc/hostname
cat >/rootfs/etc/hosts <<'OPENLINK_HOSTS'
127.0.0.1 localhost
127.0.1.1 openlink-project
OPENLINK_HOSTS

rm -f /rootfs/etc/resolv.conf
ln -s /run/systemd/resolve/stub-resolv.conf /rootfs/etc/resolv.conf
rm -rf /rootfs/var/lib/cloud/*
mkdir -p /rootfs/var/lib/cloud/seed/nocloud
rm -f /rootfs/etc/ssh/ssh_host_*
rm -rf /rootfs/home/openlink/.ssh
rm -rf /rootfs/root/.ssh
truncate -s 0 /rootfs/etc/machine-id
truncate -s 0 /rootfs/var/lib/dbus/machine-id
rm -rf /rootfs/tmp/* /rootfs/run/*

mkdir -p /rootfs/usr/lib/openlink
tar -xf /supabase/bundle.tar -C /rootfs
mkdir -p /rootfs/var/lib/openlink
cp /supabase/images.tar /rootfs/var/lib/openlink/project-supabase-images.tar
chmod 0600 /rootfs/var/lib/openlink/project-supabase-images.tar
cat >/rootfs/etc/systemd/system/openlink-project-supabase-images.service <<'OPENLINK_SUPABASE_IMAGES'
[Unit]
Description=Load verified Project Supabase images
After=local-fs.target
Before=podman.socket
ConditionPathExists=/var/lib/openlink/project-supabase-images.tar

[Service]
Type=oneshot
ExecStart=/bin/bash -lc 'podman load -i /var/lib/openlink/project-supabase-images.tar && rm -f /var/lib/openlink/project-supabase-images.tar && touch /var/lib/openlink/.project-supabase-images-loaded'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
OPENLINK_SUPABASE_IMAGES

mkdir -p /rootfs/etc/systemd/system/multi-user.target.wants
ln -sf /usr/lib/systemd/system/cloud-init.target /rootfs/etc/systemd/system/multi-user.target.wants/cloud-init.target
systemctl --root=/rootfs set-default multi-user.target
systemctl --root=/rootfs enable systemd-networkd systemd-resolved ssh podman.socket openlink-desktop.service openlink-project-supabase-images.service
systemctl --root=/rootfs disable gdm3 display-manager >/dev/null 2>&1 || true
# The sandbox has no managed Wi-Fi device. Leaving wpa_supplicant enabled makes
# every boot end in a failed unit and a "degraded" system state.
systemctl --root=/rootfs disable wpa_supplicant.service >/dev/null 2>&1 || true

mke2fs -t ext4 -d /rootfs -F /work/base.raw ${diskGb}G >/dev/null
qemu-img convert -f raw -O qcow2 /work/base.raw /work/base.qcow2
chmod 0444 /work/base.qcow2
`
  log('composing the bootable ext4/qcow2 Project VM disk')
  await run(docker, [
    'run', '--rm',
    '-v', `${workRoot}:/work`,
    '-v', `${projectSupabaseCache}:/supabase:ro`,
    '--entrypoint', 'bash', workerImage,
    '-lc', configScript,
  ], { timeout: 30 * 60_000 })

  const baseDisk = resolve(workRoot, 'base.qcow2')
  await run('qemu-img', ['check', baseDisk], { timeout: 10 * 60_000 })
  const diskSha = await sha256(baseDisk)
  const filename = `ubuntu-project-vm-base-${diskSha.slice(0, 16)}.qcow2`
  const publishedDisk = resolve(outputRoot, filename)
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  await rename(baseDisk, publishedDisk)
  await chmod(publishedDisk, 0o444).catch(() => undefined)
  const publishedKernel = resolve(outputRoot, boot.kernel)
  const publishedInitrd = resolve(outputRoot, boot.initrd)
  await rm(publishedKernel, { force: true })
  await rm(publishedInitrd, { force: true })
  await copyFile(kernelPath, publishedKernel)
  await copyFile(initrdPath, publishedInitrd)
  await chmod(publishedKernel, 0o444)
  await chmod(publishedInitrd, 0o444)
  const manifest = {
    schemaVersion: 1,
    platform: { os: 'linux', architecture: process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch, provider: 'qemu' },
    sourceImage: { kind: 'ubuntu-cloud-kernel', path: basename(cloud.path), sha256: cloud.sha256, bytes: (await stat(cloud.path)).size, kernelVersion: boot.version },
    kernel: { file: boot.kernel, sha256: await sha256(publishedKernel), bytes: (await stat(publishedKernel)).size },
    initrd: { file: boot.initrd, sha256: await sha256(publishedInitrd), bytes: (await stat(publishedInitrd)).size },
    disk: filename,
    diskBytes: (await stat(publishedDisk)).size,
    diskSha256: diskSha,
    baseFingerprint: diskSha,
    diskFormat: 'qcow2',
    diskVirtualBytes: diskGb * 1024 * 1024 * 1024,
    rootDevice: '/dev/vda',
    desktop: { session: isT2 ? 'ubuntu-gnome-51-wayland-rdp' : 'ubuntu-gnome-x11', websockifyPort: 6080, vncPort: 5900 },
    usersImage: { image: usersImage, nodeSource: workerImage, profile: projectVmProfile },
    packages: guestPackages,
    apps: {
        chrome: { version: '156.0.8078.79-1', packageSha256: chromeDebSha256 },
        agentDesktop: {
          version: '1.0.2',
          sourceCommit: '9eb9b296192fcb70bda25e918cd6dd66abfa3d0d',
          archiveSha256: agentDesktopReleaseSha256,
          license: 'Apache-2.0',
        },
        wallpapers: {
          set: 'astreusn-ubuntu',
          lightSha256: await sha256(resolve(root, 'services/agent-worker/desktop/wallpapers/astreusn-ubuntu/astreusn-ubuntu-light-3840x2160.png')),
          darkSha256: await sha256(resolve(root, 'services/agent-worker/desktop/wallpapers/astreusn-ubuntu/astreusn-ubuntu-dark-3840x2160.png')),
        },
      },
    projectSupabase: {
      bundleSha256: await sha256(projectSupabaseBundle),
      imagesSha256: await sha256(projectSupabaseImages),
    },
    builtAt: new Date().toISOString(),
  }
  const manifestPath = resolve(outputRoot, 'manifest.json')
  const temporaryManifest = `${manifestPath}.${process.pid}.tmp`
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryManifest, manifestPath)
  log(`published ${publishedDisk} (${manifest.diskBytes} bytes), kernel ${boot.version}`)
  await rm(workRoot, { recursive: true, force: true })
  workRoot = ''
} catch (error) {
  if (rootfsContainer) await run(docker, ['rm', '-f', rootfsContainer], { timeout: 60_000 }).catch(() => undefined)
  if (workRoot) log(`build failed; work directory retained at ${workRoot}`)
  throw error
}
