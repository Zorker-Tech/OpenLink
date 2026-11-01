import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  UbuntuQemuProjectVmDriver,
  ubuntuProjectVmQemuArguments,
  ubuntuProjectVmSeedDocuments,
} from '../src/project-vm-ubuntu.js'
import type { ProjectVmMachineSpec } from '../src/project-vm.js'

const fakePid = 9_999_999
const basePublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOpenLinkProjectVmTestKey test@openlink'

function spec(overrides: Partial<ProjectVmMachineSpec> = {}): ProjectVmMachineSpec {
  return {
    cpus: 4,
    memoryMb: 8_192,
    diskGb: 64,
    diskMode: 'thin',
    servicePorts: [51_000, 52_000, 53_000, 54_000, 55_000, 56_000],
    desktopPort: 57_000,
    sshPort: 52_101,
    ...overrides,
  }
}

test('Ubuntu VM QEMU arguments expose only loopback forwards and a cloud-init seed', () => {
  const args = ubuntuProjectVmQemuArguments({
    name: 'olp-test',
    diskPath: '/state/disk.qcow2',
    cpus: 4,
    memoryMb: 8_192,
    sshPort: 52_101,
    servicePorts: [51_000, 52_000, 53_000, 54_000, 55_000, 56_000],
    desktopPort: 57_000,
    kernelPath: '/state/vmlinuz',
    initrdPath: '/state/initrd',
    rootDevice: '/dev/vda',
    seedImagePath: '/state/seed.img',
    pidFile: '/state/qemu.pid',
    qmpPath: '/tmp/qemu.sock',
    consoleLog: '/state/console.log',
  })
  const netdev = args[args.indexOf('-netdev') + 1]!
  assert.match(netdev, /hostfwd=tcp:127\.0\.0\.1:52101-:22/)
  assert.match(netdev, /hostfwd=tcp:127\.0\.0\.1:51000-:51000/)
  assert.match(netdev, /hostfwd=tcp:127\.0\.0\.1:57000-:6080/)
  assert.ok(args.includes('-daemonize'))
  assert.ok(args.includes('-pidfile'))
  assert.match(args[args.indexOf('-append') + 1]!, /root=\/dev\/vda/)
  assert.ok(args.some((argument) => argument.includes('file=/state/seed.img')))
  assert.throws(() => ubuntuProjectVmQemuArguments({
    name: 'olp-test',
    diskPath: '/state/disk.qcow2',
    cpus: 4,
    memoryMb: 8_192,
    sshPort: 51_000,
    servicePorts: [51_000],
    kernelPath: '/state/vmlinuz',
    initrdPath: '/state/initrd',
    rootDevice: '/dev/vda',
    seedImagePath: '/state/seed.img',
    pidFile: '/state/qemu.pid',
    qmpPath: '/tmp/qemu.sock',
    consoleLog: '/state/console.log',
  }), /collide/)
})

test('Ubuntu cloud-init seed injects only the per-project public key', () => {
  const documents = ubuntuProjectVmSeedDocuments({
    name: 'olp-test',
    instanceId: 'olp-test-1234',
    publicKey: basePublicKey,
    guestUser: 'ubuntu',
  })
  assert.match(documents.get('user-data')!, /ALL=\(ALL\) NOPASSWD:ALL/)
  assert.match(documents.get('user-data')!, /ssh_authorized_keys:/)
  assert.ok(documents.get('user-data')!.includes(basePublicKey))
  assert.match(documents.get('user-data')!, /ssh_pwauth: false/)
  assert.match(documents.get('meta-data')!, /instance-id: olp-test-1234/)
  assert.match(documents.get('meta-data')!, /local-hostname: olp-test/)
  assert.throws(() => ubuntuProjectVmSeedDocuments({
    name: 'olp-test',
    instanceId: 'olp-test-1234',
    publicKey: 'not-a-key',
    guestUser: 'ubuntu',
  }), /public key is invalid/)
})

test('creates, reattaches, stops and removes a durable Ubuntu Project VM', async (context) => {
  const root = await mkdtemp(join('/tmp', 'openlink-ubuntu-driver-'))
  const base = join(root, 'base.qcow2')
  const stateRoot = join(root, 'state')
  await writeFile(base, 'base-image')
  let running = false
  let qemuStarts = 0
  let lastQemuArgs: string[] = []
  const calls: Array<{ file: string; args: string[] }> = []
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args })
    if (file.endsWith('ssh-keygen')) {
      const keyPath = args[args.indexOf('-f') + 1]!
      await writeFile(keyPath, 'PRIVATE KEY')
      await writeFile(`${keyPath}.pub`, `${basePublicKey}\n`)
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('mke2fs')) {
      const seedImage = args[args.indexOf('-F') + 1]!
      await writeFile(seedImage, 'seed-image')
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('qemu-img')) {
      const action = args[0]
      const disk = action === 'create' || action === 'convert'
        ? args[args.length - 2]!
        : args[1]
      if (action === 'info') {
        return {
          stdout: JSON.stringify({
            format: 'qcow2',
            'virtual-size': 64 * 1024 * 1024 * 1024,
            'full-backing-filename': base,
          }),
          stderr: '',
        }
      }
      if (action === 'create' || action === 'convert') {
        await writeFile(disk, 'disk')
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('qemu-system-x86_64')) {
      qemuStarts += 1
      lastQemuArgs = args
      running = true
      await writeFile(args[args.indexOf('-pidfile') + 1]!, `${fakePid}\n`)
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('ssh')) {
      if (String(args.at(-1)).includes('poweroff')) running = false
      return { stdout: 'ok\n', stderr: '' }
    }
    if (file.endsWith('scp')) return { stdout: '', stderr: '' }
    throw new Error(`unexpected command ${file}`)
  }
  const kernel = join(root, 'vmlinuz')
  const initrd = join(root, 'initrd')
  await writeFile(kernel, 'kernel')
  await writeFile(initrd, 'initrd')
  const driver = new UbuntuQemuProjectVmDriver({
    projectBaseDisk: base,
    kernelPath: kernel,
    initrdPath: initrd,
    baseFingerprint: 'base-v1',
    stateRoot,
    socketRoot: join(root, 'sockets'),
    run,
    isProcessRunning: async () => running,
    hostPortAvailable: async () => true,
    startTimeoutMs: 5_000,
    commandTimeoutMs: 5_000,
  })
  const name = 'olp-test'
  const stateDirectory = join(stateRoot, 'ubuntu-vms', name)
  try {
    await driver.ensureMachine(name, spec())
    assert.equal(qemuStarts, 1)
    assert.ok(lastQemuArgs.includes('-accel'))
    assert.ok(lastQemuArgs.includes('kvm'))
    assert.ok(running)
    for (const file of ['vm.json', 'disk.qcow2', 'seed.json', 'id_ed25519', 'id_ed25519.pub']) {
      assert.ok(await stat(join(stateDirectory, file)).then(() => true), `${file} must be durable`)
    }
    assert.ok(calls.some((call) => call.file.endsWith('ssh') && call.args.at(-1)?.includes('podman version')))

    await driver.ensureMachine(name, spec())
    assert.equal(qemuStarts, 1, 'a running VM must be reattached, not restarted')

    const result = await driver.runInMachine(name, 'echo', ['hello'])
    assert.equal(result.stdout, 'ok\n')
    await driver.copyToMachine(name, '/tmp/source', '/var/tmp/target')
    assert.ok(calls.some((call) => call.file.endsWith('scp')))

    await driver.stopMachine(name)
    assert.equal(running, false)
    await driver.ensureMachine(name, spec())
    assert.equal(qemuStarts, 2, 'a stopped VM must restart from its durable disk')

    await driver.removeMachine(name)
    assert.equal(await stat(stateDirectory).then(() => true).catch(() => false), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when a durable Ubuntu Project VM disk disappears', async () => {
  const root = await mkdtemp(join('/tmp', 'openlink-ubuntu-driver-loss-'))
  const base = join(root, 'base.qcow2')
  const stateRoot = join(root, 'state')
  await writeFile(base, 'base-image')
  let running = false
  const run = async (file: string, args: string[]) => {
    if (file.endsWith('ssh-keygen')) {
      const keyPath = args[args.indexOf('-f') + 1]!
      await writeFile(keyPath, 'PRIVATE KEY')
      await writeFile(`${keyPath}.pub`, `${basePublicKey}\n`)
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('mke2fs')) {
      const seedImage = args[args.indexOf('-F') + 1]!
      await writeFile(seedImage, 'seed-image')
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('qemu-img')) {
      if (args[0] === 'info') return { stdout: JSON.stringify({ format: 'qcow2', 'virtual-size': 64 * 1024 * 1024 * 1024, 'full-backing-filename': base }), stderr: '' }
      const disk = args[0] === 'resize' ? args[1]! : args[args.length - 2]!
      await writeFile(disk, 'disk')
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('qemu-system-x86_64')) {
      running = true
      await writeFile(args[args.indexOf('-pidfile') + 1]!, `${fakePid}\n`)
      return { stdout: '', stderr: '' }
    }
    if (file.endsWith('ssh')) {
      if (String(args.at(-1)).includes('poweroff')) running = false
      return { stdout: 'ok\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const kernel = join(root, 'vmlinuz')
  const initrd = join(root, 'initrd')
  await writeFile(kernel, 'kernel')
  await writeFile(initrd, 'initrd')
  const driver = new UbuntuQemuProjectVmDriver({
    projectBaseDisk: base,
    kernelPath: kernel,
    initrdPath: initrd,
    stateRoot,
    socketRoot: join(root, 'sockets'),
    run,
    isProcessRunning: async () => running,
    hostPortAvailable: async () => true,
    startTimeoutMs: 5_000,
    commandTimeoutMs: 5_000,
  })
  const name = 'olp-test'
  try {
    await driver.ensureMachine(name, spec())
    await driver.stopMachine(name)
    await rm(join(stateRoot, 'ubuntu-vms', name, 'disk.qcow2'))
    await assert.rejects(() => driver.ensureMachine(name, spec()), /disk is missing/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
