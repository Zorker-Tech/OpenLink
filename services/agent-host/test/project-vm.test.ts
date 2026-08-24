import assert from 'node:assert/strict'
import { lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { ProjectVmManager, PodmanMachineDriver, appleHvMachineHasBooted, cloneThinProjectVmDisk, type ProjectVmCommandResult } from '../src/project-vm.js'

const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'

test('distinguishes never-booted AppleHV configs from machines already provisioned by Podman', () => {
  assert.equal(appleHvMachineHasBooted({}), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: '' }), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: '0001-01-01T00:00:00Z' }), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: 'not-a-time' }), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: '2026-08-10T05:54:02.476379+08:00' }), true)
})

test('creates a durable project machine and bootstraps the development toolchain', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  let inspected = false
  const run = async (command: string, args: string[]): Promise<ProjectVmCommandResult> => {
    calls.push({ command, args })
    if (args[0] === 'machine' && args[1] === 'inspect' && !inspected) {
      inspected = true
      throw new Error('machine openlink-project-2c51ca263cd04 does not exist')
    }
    return { stdout: args[1] === 'inspect' ? JSON.stringify([{ State: 'running' }]) : '', stderr: '' }
  }
  const root = await mkdtemp(`${tmpdir()}/openlink-project-vm-`)
  try {
    const manager = new ProjectVmManager({
      stateRoot: root,
      machineDriver: new PodmanMachineDriver({ run }),
      machinePrefix: 'openlink-project',
    })
    const descriptor = await manager.ensure(projectId, { diskMode: 'thin' })
    assert.equal(descriptor.status, 'ready')
    assert.equal(descriptor.machineName, 'openlink-project-2c51ca263cd04')
    assert.equal(descriptor.diskMode, 'thin')
    assert.match(await readFile(`${root}/projects/${projectId}/runtime.json`, 'utf8'), /"status":"ready"/)
    assert.deepEqual(calls[0]?.args.slice(0, 3), ['machine', 'inspect', descriptor.machineName])
    assert.deepEqual(calls[1]?.args.slice(0, 2), ['machine', 'init'])
    const bootstrap = calls.find((call) => call.args[0] === 'machine' && call.args[1] === 'ssh')
    assert.ok(bootstrap)
    assert.match(bootstrap.args.at(-1) ?? '', /for required in git node npm pnpm python3/)
    assert.doesNotMatch(bootstrap.args.at(-1) ?? '', /apt-get|dnf install|apk add|npm install --global/)
    assert.match(bootstrap.args.at(-1) ?? '', /userns = "keep-id"/)
    await manager.remove(projectId)
    await assert.rejects(() => readFile(`${root}/projects/${projectId}/runtime.json`), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not accept a path-shaped or malformed project identifier', async () => {
  const manager = new ProjectVmManager({
    stateRoot: '/tmp/openlink-project-vm-test',
    machineDriver: new PodmanMachineDriver({ run: async () => ({ stdout: '', stderr: '' }) }),
  })
  await assert.rejects(() => manager.ensure('../escape'), /projectId is invalid/)
})

test('uses the locally published OpenLink boot disk as the Project VM base', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const clones: Array<{ source: string; destination: string }> = []
  let inspectReads = 0
  const root = await mkdtemp(`${tmpdir()}/openlink-project-base-`)
  const destination = `${root}/project-machine.raw`
  await writeFile(destination, Buffer.alloc(4_096), { mode: 0o600 })
  const run = async (command: string, args: string[]): Promise<ProjectVmCommandResult> => {
    calls.push({ command, args })
    if (args[0] === 'machine' && args[1] === 'inspect') {
      inspectReads += 1
      if (inspectReads === 1) throw new Error('machine openlink-project-base does not exist')
      return { stdout: JSON.stringify([{ State: 'running', ImagePath: { Path: destination } }]), stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  try {
    const driver = new PodmanMachineDriver({
      run,
      bootstrap: false,
      projectBaseDisk: '/tmp/openlink-project-vm-base.raw',
      cloneDisk: async (source, target) => { clones.push({ source, destination: target }) },
    })
    await driver.ensureMachine('openlink-project-base', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' })
    const init = calls.find((call) => call.args[0] === 'machine' && call.args[1] === 'init')
    const imageIndex = init?.args.indexOf('--image') ?? -1
    assert.ok(imageIndex >= 0)
    assert.match(init?.args[imageIndex + 1] ?? '', /openlink-podman-init-.+\/placeholder\.raw$/)
    assert.deepEqual(clones, [{ source: '/tmp/openlink-project-vm-base.raw', destination }])
    assert.ok(calls.some((call) => call.args[0] === 'machine' && call.args[1] === 'start'))
    assert.doesNotMatch(calls.map((call) => call.args.join(' ')).join('\n'), /bootc switch|oci-archive/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializes an independent Project VM disk for thick allocation', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const materialized: Array<{ source: string; destination: string }> = []
  let inspectReads = 0
  const root = await mkdtemp(`${tmpdir()}/openlink-project-thick-`)
  const destination = `${root}/project-machine-thick.raw`
  await writeFile(destination, Buffer.alloc(4_096), { mode: 0o600 })
  const run = async (command: string, args: string[]): Promise<ProjectVmCommandResult> => {
    calls.push({ command, args })
    if (args[0] === 'machine' && args[1] === 'inspect') {
      inspectReads += 1
      if (inspectReads === 1) throw new Error('machine openlink-project-thick does not exist')
      return { stdout: JSON.stringify([{ State: 'running', ImagePath: { Path: destination } }]), stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  try {
    const driver = new PodmanMachineDriver({
      run,
      bootstrap: false,
      projectBaseDisk: '/tmp/openlink-project-vm-base.raw',
      cloneDisk: async () => { throw new Error('thin clone must not be used') },
      materializeDisk: async (source, target) => { materialized.push({ source, destination: target }) },
    })

    await driver.ensureMachine('openlink-project-thick', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thick' })

    assert.deepEqual(materialized, [{ source: '/tmp/openlink-project-vm-base.raw', destination }])
    assert.ok(calls.some((call) => call.args[0] === 'machine' && call.args[1] === 'start'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves the AppleHV disk from Podman data root when inspect omits ImagePath', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const clones: Array<{ source: string; destination: string }> = []
  let inspectReads = 0
  const root = await mkdtemp(`${tmpdir()}/openlink-podman-data-`)
  const destination = `${root}/project-machine.raw`
  await writeFile(destination, Buffer.alloc(4_096), { mode: 0o600 })
  try {
    const driver = new PodmanMachineDriver({
      run: async (command, args) => {
        calls.push({ command, args })
        if (args[0] === 'machine' && args[1] === 'inspect') {
          inspectReads += 1
          if (inspectReads === 1) throw new Error('machine openlink-project-derived does not exist')
          return { stdout: JSON.stringify([{ State: 'stopped' }]), stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
      bootstrap: false,
      projectBaseDisk: '/tmp/openlink-project-vm-base.raw',
      machineDiskPath: () => destination,
      cloneDisk: async (source, target) => { clones.push({ source, destination: target }) },
    })
    await driver.ensureMachine('openlink-project-derived', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' })
    assert.deepEqual(clones, [{ source: '/tmp/openlink-project-vm-base.raw', destination }])
    assert.ok(calls.some((call) => call.args[1] === 'start'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('publishes an independent native CoW clone without materializing sparse holes', async (context) => {
  const root = await mkdtemp(`${tmpdir()}/openlink-project-thin-clone-`)
  const source = `${root}/golden.raw`
  const destination = `${root}/project.raw`
  const logicalBytes = 64 * 1024 * 1024
  const marker = Buffer.from('openlink-golden-disk')
  try {
    const sourceHandle = await open(source, 'w', 0o600)
    try {
      await sourceHandle.truncate(logicalBytes)
      await sourceHandle.write(marker, 0, marker.length, 0)
      await sourceHandle.write(marker, 0, marker.length, logicalBytes - marker.length)
      await sourceHandle.sync()
    } finally {
      await sourceHandle.close()
    }
    const destinationHandle = await open(destination, 'w', 0o600)
    try {
      await destinationHandle.truncate(logicalBytes)
    } finally {
      await destinationHandle.close()
    }

    try {
      await cloneThinProjectVmDisk(source, destination)
    } catch (error) {
      if (/reflink|clonefile|operation not supported|not supported|invalid argument/i.test(error instanceof Error ? error.message : String(error))) {
        context.skip('host test filesystem does not support mandatory native CoW clones')
        return
      }
      throw error
    }

    const sourceStats = await lstat(source)
    const cloneStats = await lstat(destination)
    assert.equal(cloneStats.size, logicalBytes)
    assert.ok(cloneStats.blocks * 512 < logicalBytes * 0.9)
    assert.ok(cloneStats.blocks * 512 <= sourceStats.blocks * 512 + 512 * 1024 * 1024)

    const cloneHandle = await open(destination, 'r+')
    try {
      await cloneHandle.write(Buffer.from('project-private'), 0, 'project-private'.length, 0)
      await cloneHandle.sync()
    } finally {
      await cloneHandle.close()
    }
    const sourcePrefix = Buffer.alloc(marker.length)
    const sourceReader = await open(source, 'r')
    try {
      await sourceReader.read(sourcePrefix, 0, sourcePrefix.length, 0)
    } finally {
      await sourceReader.close()
    }
    assert.deepEqual(sourcePrefix, marker)
    assert.equal((await readdir(root)).some((entry) => entry.includes('.clone-')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a materialized Golden Disk without publishing or leaving clone staging files', async () => {
  const root = await mkdtemp(`${tmpdir()}/openlink-project-thin-reject-`)
  const source = `${root}/golden.raw`
  const destination = `${root}/project.raw`
  try {
    await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 0x5a), { mode: 0o600 })
    await writeFile(destination, Buffer.alloc(4_096), { mode: 0o600 })
    await assert.rejects(() => cloneThinProjectVmDisk(source, destination), /Golden Disk is not thin/)
    assert.equal((await lstat(destination)).size, 4_096)
    assert.equal((await readdir(root)).some((entry) => entry.includes('.clone-')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removes an incomplete Podman machine when its destination is not the protected placeholder', async () => {
  const root = await mkdtemp(`${tmpdir()}/openlink-project-invalid-placeholder-`)
  const destination = `${root}/project.raw`
  const calls: Array<string[]> = []
  let inspectReads = 0
  await writeFile(destination, 'invalid', { mode: 0o600 })
  try {
    const driver = new PodmanMachineDriver({
      bootstrap: false,
      projectBaseDisk: '/tmp/openlink-project-vm-base.raw',
      run: async (_command, args) => {
        calls.push(args)
        if (args[0] === 'machine' && args[1] === 'inspect') {
          inspectReads += 1
          if (inspectReads === 1) throw new Error('machine openlink-project-invalid does not exist')
          return { stdout: JSON.stringify([{ State: 'stopped', ImagePath: { Path: destination } }]), stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
    })
    await assert.rejects(
      () => driver.ensureMachine('openlink-project-invalid', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' }),
      /placeholder has unexpected logical size/,
    )
    assert.ok(calls.some((args) => args[0] === 'machine' && args[1] === 'rm' && args.includes('--force')))
    assert.equal(calls.some((args) => args[0] === 'machine' && args[1] === 'start'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects changing allocation mode for an existing Project VM', async () => {
  const root = await mkdtemp(`${tmpdir()}/openlink-project-vm-mode-`)
  const machineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  try {
    const manager = new ProjectVmManager({ stateRoot: root, machineDriver })
    await manager.ensure(projectId, { diskMode: 'thin' })
    await assert.rejects(() => manager.ensure(projectId, { diskMode: 'thick' }), /disk mode is immutable/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails explicitly when the Podman executable is unavailable', async () => {
  const manager = new ProjectVmManager({
    stateRoot: '/tmp/openlink-project-vm-test',
    machineDriver: new PodmanMachineDriver({ command: 'openlink-podman-does-not-exist' }),
  })
  await assert.rejects(
    () => manager.ensure(projectId),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'BACKEND_NOT_CONFIGURED'
      && error.message.includes('spawn openlink-podman-does-not-exist ENOENT'),
  )
})
