#!/usr/bin/env node
// Build the immutable Ubuntu Project VM base used by T1.
//
// The base is a 64 GiB qcow2 built from the official Ubuntu 24.04 LTS cloud
// image. cloud-init installs rootful Podman, SSH, a native Xfce/GNOME desktop,
// x11vnc and websockify over the guest network; the build then removes every
// build credential, cloud-init instance state, machine-id and SSH host key so
// each project disk cloned from this base performs its own first boot.
//
// Requirements: qemu-system-x86_64, qemu-img, ssh, scp, ssh-keygen and KVM.
// It does not require xorriso, genisoimage or Docker: cloud-init reads the
// per-build seed through QEMU SMBIOS and a loopback HTTP server.

import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(new URL('..', import.meta.url).pathname)
const cloudImageUrl = process.env.OPENLINK_UBUNTU_CLOUD_IMAGE_URL?.trim()
  || 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img'
const checksumsUrl = cloudImageUrl.replace(/[^/]+$/, 'SHA256SUMS')
const cacheRoot = resolve(process.env.OPENLINK_UBUNTU_CLOUD_CACHE || resolve(homedir(), '.cache/openlink/ubuntu-cloud'))
const cloudImage = resolve(cacheRoot, basename(cloudImageUrl))
const outputRoot = resolve(process.env.OPENLINK_UBUNTU_PROJECT_VM_OUTPUT || resolve(root, '.openlink-runtime/project-vm-base/ubuntu'))
const aptMirror = process.env.OPENLINK_UBUNTU_APT_MIRROR?.trim() || ''
const qemu = process.env.OPENLINK_QEMU_SYSTEM_COMMAND?.trim() || 'qemu-system-x86_64'
const qemuImg = process.env.OPENLINK_QEMU_IMG_COMMAND?.trim() || 'qemu-img'
const ssh = process.env.OPENLINK_SSH_COMMAND?.trim() || '/usr/bin/ssh'
const scp = process.env.OPENLINK_SCP_COMMAND?.trim() || '/usr/bin/scp'
const buildTimeoutMs = Number(process.env.OPENLINK_UBUNTU_VM_BUILD_TIMEOUT_MS || 60 * 60_000)
const diskGb = Number(process.env.OPENLINK_UBUNTU_PROJECT_VM_DISK_GB || 64)
const memoryMb = Number(process.env.OPENLINK_UBUNTU_BUILD_MEMORY_MB || 6_144)
const cpus = Number(process.env.OPENLINK_UBUNTU_BUILD_CPUS || 4)
const seedToken = randomBytes(16).toString('hex')

if (aptMirror && (!/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+\/?$/.test(aptMirror) || /['"\s]/.test(aptMirror))) {
  throw new Error('OPENLINK_UBUNTU_APT_MIRROR must be a safe http(s) URL')
}

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
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
    cwd: options.cwd,
  })
}

async function portAvailable(port) {
  return new Promise((resolveAvailability) => {
    const server = createNetServer()
    server.unref()
    server.once('error', () => resolveAvailability(false))
    server.listen(port, '127.0.0.1', () => server.close((error) => resolveAvailability(!error)))
  })
}

async function freePort(start = 20_000) {
  for (let port = start; port < start + 2_000; port += 1) {
    if (await portAvailable(port)) return port
  }
  throw new Error('No free loopback port for the Ubuntu base build')
}

async function downloadCloudImage() {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  let expected
  try {
    const response = await fetch(checksumsUrl, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const sums = await response.text()
    const line = sums.split('\n').find((item) => {
      const value = item.trim()
      return value.endsWith(`*${basename(cloudImageUrl)}`) || value.endsWith(` ${basename(cloudImageUrl)}`)
    })
    expected = line?.trim().split(/\s+/)[0]
  } catch (error) {
    throw new Error(`Ubuntu cloud image checksum manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) throw new Error('Ubuntu cloud image checksum manifest is invalid')
  if (existsSync(cloudImage)) {
    const actual = await sha256(cloudImage)
    if (actual === expected) {
      log(`reusing verified cloud image ${cloudImage}`)
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
  log(`verified cloud image ${cloudImage}`)
  return { path: cloudImage, sha256: actual }
}

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n')
}

const desktopSession = `#!/usr/bin/env bash
set -u
export HOME=/home/ubuntu
export DISPLAY=:0
export XDG_SESSION_TYPE=x11
export XDG_CURRENT_DESKTOP=ubuntu:GNOME
export GNOME_SHELL_SESSION_MODE=ubuntu
export LIBGL_ALWAYS_SOFTWARE=1
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

start_xvfb() {
  if xdpyinfo -display :0 >/dev/null 2>&1; then return 0; fi
  Xvfb :0 -screen 0 1600x900x24 -nolisten tcp -ac +extension RANDR >/tmp/openlink-xvfb.log 2>&1 &
  for _ in $(seq 1 100); do
    xdpyinfo -display :0 >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

start_gnome() {
  dbus-run-session -- gnome-session --session=ubuntu >/tmp/openlink-gnome.log 2>&1 &
}

start_xfce() {
  XDG_CURRENT_DESKTOP=XFCE DESKTOP_SESSION=xfce dbus-run-session -- xfce4-session >/tmp/openlink-xfce.log 2>&1 &
}

start_xvfb || exit 1
desktop_pid=''
if command -v gnome-session >/dev/null 2>&1; then
  start_gnome
  for _ in $(seq 1 100); do
    if pgrep -u ubuntu -x gnome-shell >/dev/null 2>&1; then
      desktop_pid="$(pgrep -u ubuntu -x gnome-session | head -1)"
      break
    fi
    sleep 0.2
  done
  if [ -z "$desktop_pid" ]; then
    pkill -u ubuntu -x gnome-session 2>/dev/null || true
    pkill -u ubuntu -x gnome-shell 2>/dev/null || true
  fi
fi
if [ -z "$desktop_pid" ]; then
  if ! command -v xfce4-session >/dev/null 2>&1; then
    echo "No supported Ubuntu desktop session is installed" >&2
    exit 1
  fi
  start_xfce
  for _ in $(seq 1 100); do
    desktop_pid="$(pgrep -u ubuntu -x xfce4-session | head -1 || true)"
    [ -n "$desktop_pid" ] && break
    sleep 0.2
  done
fi
[ -n "$desktop_pid" ] || { echo "Ubuntu desktop session did not start" >&2; exit 1; }

x11vnc -display :0 -forever -shared -rfbport 5900 -localhost -nopw -xrandr >/tmp/openlink-x11vnc.log 2>&1 &
x11vnc_pid=$!
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/openlink-websockify.log 2>&1 &
websockify_pid=$!
while true; do
  if ! kill -0 "$desktop_pid" 2>/dev/null || ! kill -0 "$x11vnc_pid" 2>/dev/null || ! kill -0 "$websockify_pid" 2>/dev/null; then
    echo "A project desktop component exited" >&2
    exit 1
  fi
  sleep 2
done
`

const desktopLauncher = `#!/usr/bin/env bash
set -euo pipefail
uid="$(id -u ubuntu)"
runtime="/run/user/$uid"
mkdir -p "$runtime"
chown ubuntu:ubuntu "$runtime"
chmod 700 "$runtime"
exec runuser -u ubuntu -- env HOME=/home/ubuntu XDG_RUNTIME_DIR="$runtime" \\
  /usr/local/bin/openlink-desktop-session
`

const desktopUnit = `[Unit]
Description=OpenLink project native Ubuntu desktop
After=network-online.target cloud-init.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/openlink-desktop-start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`

const prepareScript = `#!/bin/bash
set -u
rootdev=$(findmnt -n -o SOURCE /)
parent=$(lsblk -no PKNAME "$rootdev" || true)
partnum=$(echo "$rootdev" | sed 's/^[^0-9]*//')
if [ -n "$parent" ] && [ -n "$partnum" ]; then
  growpart "/dev/$parent" "$partnum" >/dev/null 2>&1 || true
fi
resize2fs "$rootdev" >/dev/null 2>&1 || true
systemctl daemon-reload
systemctl disable --now gdm3.service >/dev/null 2>&1 || true
systemctl disable --now display-manager.service >/dev/null 2>&1 || true
systemctl enable podman.socket ssh openlink-desktop.service
systemctl start podman.socket ssh
systemctl start openlink-desktop.service || true
touch /var/lib/openlink-base-ready
`

const verifyScript = `#!/bin/bash
set -eu
for command in podman curl x11vnc websockify; do command -v "$command" >/dev/null; done
test -d /usr/share/novnc
command -v gnome-session >/dev/null || command -v xfce4-session >/dev/null
sudo -n true
sudo -n podman version >/dev/null
systemctl is-enabled --quiet podman.socket
systemctl is-enabled --quiet ssh
systemctl is-enabled --quiet openlink-desktop.service
for _ in $(seq 1 60); do
  if curl -sf --max-time 5 http://127.0.0.1:6080/vnc.html >/dev/null; then
    echo DESKTOP_READY
    exit 0
  fi
  sleep 2
done
echo DESKTOP_NOT_READY
exit 1
`

const finalizeScript = `#!/bin/bash
set -eu
cloud-init clean --logs --seed --machine-id
rm -rf /var/lib/cloud/*
truncate -s 0 /etc/machine-id
rm -f /etc/ssh/ssh_host_*
rm -f /home/ubuntu/.ssh/authorized_keys
rm -f /var/tmp/openlink-base-finalize.sh
sync
sudo -n poweroff
`

const aptBase = aptMirror.replace(/\/+$/, '')
const aptConfig = aptBase
  ? `apt:
  preserve_sources_list: false
  sources_list: |
    deb ${aptBase} noble main restricted universe multiverse
    deb ${aptBase} noble-updates main restricted universe multiverse
    deb ${aptBase} noble-backports main restricted universe multiverse
    deb ${aptBase} noble-security main restricted universe multiverse
`
  : ''

const basePackages = [
  'podman',
  'openssh-server',
  'sudo',
  'cloud-init',
  'cloud-guest-utils',
  'curl',
  'ca-certificates',
  'nodejs',
  'git',
  'openssl',
  'dbus-x11',
  'xvfb',
  'x11vnc',
  'websockify',
  'novnc',
  'xfce4',
  'xfce4-terminal',
  'thunar',
  'ubuntu-desktop-minimal',
  'gnome-terminal',
  'nautilus',
  'fonts-dejavu-core',
]

const userData = `#cloud-config
hostname: openlink-ubuntu-base
manage_etc_hosts: true
users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: [sudo, adm]
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - PUBLIC_KEY_PLACEHOLDER
ssh_pwauth: false
disable_root: true
package_update: true
package_upgrade: false
timezone: UTC
${aptConfig}packages:
${basePackages.map((name) => `  - ${name}`).join('\n')}
write_files:
  - path: /usr/local/bin/openlink-base-prepare
    permissions: '0755'
    owner: root:root
    content: |
${indent(prepareScript, 6)}
  - path: /usr/local/bin/openlink-base-verify
    permissions: '0755'
    owner: root:root
    content: |
${indent(verifyScript, 6)}
  - path: /usr/local/bin/openlink-desktop-session
    permissions: '0755'
    owner: root:root
    content: |
${indent(desktopSession, 6)}
  - path: /usr/local/bin/openlink-desktop-start
    permissions: '0755'
    owner: root:root
    content: |
${indent(desktopLauncher, 6)}
  - path: /etc/systemd/system/openlink-desktop.service
    permissions: '0644'
    owner: root:root
    content: |
${indent(desktopUnit, 6)}
  - path: /etc/systemd/system/ssh.service.d/10-openlink-host-keys.conf
    permissions: '0644'
    owner: root:root
    content: |
      [Service]
      ExecStartPre=/usr/sbin/ssh-keygen -A
  - path: /etc/ssh/sshd_config.d/90-openlink.conf
    permissions: '0644'
    owner: root:root
    content: |
      PasswordAuthentication no
      PermitRootLogin no
  - path: /etc/sudoers.d/90-openlink
    permissions: '0440'
    owner: root:root
    content: |
      ubuntu ALL=(ALL) NOPASSWD:ALL
runcmd:
  - [ sh, -c, "/usr/local/bin/openlink-base-prepare" ]
`

const seedDocuments = new Map([
  ['user-data', userData],
  ['meta-data', 'instance-id: openlink-ubuntu-base-build\nlocal-hostname: openlink-ubuntu-base\n'],
  ['vendor-data', ''],
  ['network-config', 'version: 2\n'],
])

if (process.env.OPENLINK_UBUNTU_PRINT_USER_DATA === '1') {
  process.stdout.write(userData)
  process.exit(0)
}

const seedServer = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const prefix = `/seed/${seedToken}/`
  if (request.method !== 'GET' || !url.pathname.startsWith(prefix)) {
    response.writeHead(404, { 'Cache-Control': 'no-store' })
    response.end()
    return
  }
  const value = seedDocuments.get(url.pathname.slice(prefix.length))
  if (value === undefined) {
    response.writeHead(404, { 'Cache-Control': 'no-store' })
    response.end()
    return
  }
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' })
  response.end(value)
})

let qemuChild
let seedServerStarted = false
let workRoot = ''
try {
  const cloud = await downloadCloudImage()
  workRoot = resolve(outputRoot, `.build-${process.pid}-${randomBytes(4).toString('hex')}`)
  await mkdir(workRoot, { recursive: true, mode: 0o700 })
  const baseDisk = resolve(workRoot, 'base.qcow2')
  const keyPath = resolve(workRoot, 'id_ed25519')
  const consoleLog = resolve(workRoot, 'console.log')
  const sshPort = await freePort()

  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { timeout: 30_000 })
  const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()
  seedDocuments.set('user-data', userData.replace('PUBLIC_KEY_PLACEHOLDER', publicKey))

  await new Promise((accept, reject) => {
    seedServer.once('error', reject)
    seedServer.listen(0, '127.0.0.1', accept)
  })
  seedServerStarted = true
  const seedAddress = seedServer.address()
  if (!seedAddress || typeof seedAddress === 'string') throw new Error('Ubuntu build seed server did not bind')
  const seedUrl = `http://10.0.2.2:${seedAddress.port}/seed/${seedToken}/`

  log(`creating ${diskGb} GiB qcow2 overlay from the verified cloud image`)
  await run(qemuImg, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', cloud.path, baseDisk, `${diskGb}G`], { timeout: 120_000 })

  const qemuArgs = [
    '-name', 'openlink-ubuntu-base-build',
    '-machine', 'q35',
    '-accel', 'kvm',
    '-cpu', 'host',
    '-smp', String(cpus),
    '-m', String(memoryMb),
    '-drive', `file=${baseDisk},if=virtio,format=qcow2,cache=none`,
    '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
    '-device', 'virtio-net-pci,netdev=net0',
    '-smbios', `type=1,serial=ds=nocloud;s=${seedUrl}`,
    '-display', 'none',
    '-serial', `file:${consoleLog}`,
    '-no-reboot',
  ]
  log('booting the Ubuntu base builder (cloud-init installs Podman and the native desktop)')
  qemuChild = execFileCallback(qemu, qemuArgs, { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })
  let qemuHostLog = ''
  qemuChild.stdout?.resume()
  qemuChild.stderr?.on('data', (chunk) => {
    qemuHostLog = `${qemuHostLog}${chunk}`.slice(-16_000)
  })
  const qemuExit = new Promise((resolveExit) => qemuChild.once('exit', (code, signal) => resolveExit({ code, signal })))

  const sshArgs = (command) => [
    '-i', keyPath,
    '-p', String(sshPort),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    'ubuntu@127.0.0.1',
    command,
  ]

  const deadline = Date.now() + buildTimeoutMs
  let ready = false
  let lastError
  while (Date.now() < deadline) {
    if (qemuChild.exitCode !== null) {
      throw new Error(`Ubuntu base builder exited with code ${qemuChild.exitCode}${qemuHostLog ? `: ${qemuHostLog.slice(-4_000)}` : ''}`)
    }
    try {
      const marker = await run(ssh, sshArgs('test -f /var/lib/openlink-base-ready && echo READY'), { timeout: 30_000 })
      if (marker.stdout.includes('READY')) {
        ready = true
        break
      }
    } catch (error) {
      lastError = error
    }
    await delay(10_000)
  }
  if (!ready) {
    const tail = await readFile(consoleLog, 'utf8').catch(() => '')
    throw new Error(`Ubuntu base build did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}${qemuHostLog ? `\n${qemuHostLog.slice(-4_000)}` : ''}\n${tail.slice(-8_000)}`)
  }

  log('base packages installed; verifying the native desktop, SSH and Podman')
  const verification = await run(ssh, sshArgs('bash /usr/local/bin/openlink-base-verify'), { timeout: 180_000 })
  if (!verification.stdout.includes('DESKTOP_READY')) {
    throw new Error(`Ubuntu base desktop did not become ready: ${verification.stdout}${verification.stderr}`)
  }
  log('native desktop and websockify are ready; removing build state')

  const finalizePath = resolve(workRoot, 'finalize.sh')
  await writeFile(finalizePath, finalizeScript, { mode: 0o600 })
  await run(scp, [
    '-i', keyPath,
    '-P', String(sshPort),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    finalizePath,
    'ubuntu@127.0.0.1:/var/tmp/openlink-base-finalize.sh',
  ], { timeout: 60_000 })
  await run(ssh, sshArgs('sudo -n bash /var/tmp/openlink-base-finalize.sh'), { timeout: 60_000 }).catch(() => undefined)
  const exit = await Promise.race([
    qemuExit,
    delay(120_000).then(() => ({ timeout: true })),
  ])
  if (exit && exit.timeout) {
    qemuChild.kill('SIGTERM')
    throw new Error('Ubuntu base builder did not power off within 120 seconds')
  }

  log('collapsing the base disk to a standalone qcow2')
  const convertedDisk = resolve(workRoot, 'ubuntu-project-vm-base.qcow2')
  await run(qemuImg, ['convert', '-O', 'qcow2', baseDisk, convertedDisk], { timeout: 30 * 60_000 })
  await run(qemuImg, ['check', '-r', 'leaks', convertedDisk], { timeout: 30 * 60_000 }).catch((error) => {
    throw new Error(`Ubuntu base disk failed qemu-img check: ${error instanceof Error ? error.message : String(error)}`)
  })
  const diskSha = await sha256(convertedDisk)
  const filename = `ubuntu-project-vm-base-${diskSha.slice(0, 16)}.qcow2`
  const publishedDisk = resolve(outputRoot, filename)
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  await rename(convertedDisk, publishedDisk)
  await chmod(publishedDisk, 0o444)
  const diskBytes = (await stat(publishedDisk)).size
  const manifest = {
    schemaVersion: 1,
    platform: { os: 'linux', architecture: process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch, provider: 'qemu' },
    sourceImage: { url: cloudImageUrl, sha256: cloud.sha256, bytes: (await stat(cloud.path)).size },
    disk: filename,
    diskBytes,
    diskSha256: diskSha,
    baseFingerprint: diskSha,
    diskFormat: 'qcow2',
    diskVirtualBytes: diskGb * 1024 * 1024 * 1024,
    desktop: { session: 'gnome-with-xfce-fallback', websockifyPort: 6080, vncPort: 5900 },
    packages: basePackages,
    builtAt: new Date().toISOString(),
  }
  const manifestPath = resolve(outputRoot, 'manifest.json')
  const temporaryManifest = `${manifestPath}.${process.pid}.tmp`
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryManifest, manifestPath)
  log(`published ${publishedDisk} (${diskBytes} bytes)`)
  await rm(workRoot, { recursive: true, force: true })
  workRoot = ''
} catch (error) {
  if (qemuChild && qemuChild.exitCode === null) qemuChild.kill('SIGTERM')
  if (workRoot) log(`build failed; work directory retained at ${workRoot}`)
  throw error
} finally {
  if (seedServerStarted) seedServer.close()
}
