import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { ProjectVmManager, PodmanMachineDriver, appleHvMachineHasBooted, cloneThinHyperVProjectVmDisk, cloneThinProjectVmDisk, prepareHyperVNetworking, type ProjectVmCommandResult } from '../src/project-vm.js'

const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'

test('distinguishes never-booted AppleHV configs from machines already provisioned by Podman', () => {
  assert.equal(appleHvMachineHasBooted({}), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: '' }), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: '0001-01-01T00:00:00Z' }), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: 'not-a-time' }), false)
  assert.equal(appleHvMachineHasBooted({ LastUp: '2026-08-10T05:54:02.476379+08:00' }), true)
})

test('reaps a surviving direct AppleHV helper before rebinding VM sockets', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(`${tmpdir()}/openlink-applehv-partial-`)
  const socketRoot = `/tmp/olp-test-${process.pid}`
  const machineName = 'openlink-project-partial'
  const stateDirectory = resolve(root, 'state', machineName)
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(resolve(stateDirectory, 'processes.json'), JSON.stringify({
    machineName,
    vfkitPid: 999_999_999,
    gvproxyPid: process.pid,
    createdAt: new Date().toISOString(),
  }))
  try {
    const driver = new PodmanMachineDriver({
      bootstrap: false,
      directAppleHv: true,
      machineProvider: 'applehv',
      helperBinaryDirectory: root,
      directStateRoot: resolve(root, 'state'),
      directSocketRoot: socketRoot,
      run: async () => ({ stdout: '', stderr: '' }),
    })
    let cleanupCalls = 0
    const internals = driver as unknown as {
      appleHvMachineConfig(name: string): Promise<unknown>
      stopDirectAppleHv(name: string): Promise<void>
      startDirectAppleHv(name: string): Promise<void>
    }
    internals.appleHvMachineConfig = async () => ({})
    internals.stopDirectAppleHv = async (name) => {
      cleanupCalls += 1
      assert.equal(name, machineName)
      throw new Error('cleanup reached before helper launch')
    }
    await assert.rejects(() => internals.startDirectAppleHv(machineName), /cleanup reached/)
    assert.equal(cleanupCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(socketRoot, { recursive: true, force: true })
  }
})

test('prepares Hyper-V networking before starting a stopped machine', async () => {
  const events: string[] = []
  const driver = new PodmanMachineDriver({
    bootstrap: false,
    machineProvider: 'hyperv',
    prepareHyperVNetworking: async (name) => { events.push(`prepare:${name}`) },
    run: async (_command, args) => {
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ State: 'stopped', Rootful: false }]), stderr: '' }
      }
      if (args[0] === 'machine' && args[1] === 'start') events.push(`start:${args[2]}`)
      return { stdout: '', stderr: '' }
    },
  })

  await driver.ensureMachine('openlink-project-network', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' })
  assert.deepEqual(events, ['prepare:openlink-project-network', 'start:openlink-project-network'])
})

test('does not start Hyper-V when networking belongs to a running machine', async () => {
  let started = false
  const driver = new PodmanMachineDriver({
    bootstrap: false,
    machineProvider: 'hyperv',
    prepareHyperVNetworking: async () => { throw new Error('networking is already owned by a running machine') },
    run: async (_command, args) => {
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ State: 'stopped', Rootful: false }]), stderr: '' }
      }
      if (args[0] === 'machine' && args[1] === 'start') started = true
      return { stdout: '', stderr: '' }
    },
  })

  await assert.rejects(
    () => driver.ensureMachine('openlink-project-conflict', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' }),
    /already owned/,
  )
  assert.equal(started, false)
})

test('reconciles a Hyper-V start error only after inspect and SSH prove readiness', async () => {
  const calls: string[] = []
  let inspection = 0
  const driver = new PodmanMachineDriver({
    bootstrap: false,
    machineProvider: 'hyperv',
    prepareHyperVNetworking: async () => undefined,
    run: async (_command, args) => {
      calls.push(args.join(' '))
      if (args[0] === 'machine' && args[1] === 'inspect') {
        inspection += 1
        return { stdout: JSON.stringify([{ State: inspection === 1 ? 'stopped' : 'running', Rootful: false }]), stderr: '' }
      }
      if (args[0] === 'machine' && args[1] === 'start') throw new Error('Podman WMI completion panic')
      if (args[0] === 'machine' && args[1] === 'ssh' && args.at(-1) === 'true') return { stdout: '', stderr: '' }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    },
  })

  await driver.ensureMachine('openlink-project-reconciled', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' })
  assert.deepEqual(calls, [
    'machine inspect openlink-project-reconciled',
    'machine start openlink-project-reconciled',
    'machine inspect openlink-project-reconciled',
    'machine ssh openlink-project-reconciled true',
  ])
})

test('invokes the host Hyper-V networking guard without interpolating arguments', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  await prepareHyperVNetworking('C:\\OpenLink Runtime\\bin', 'ol-project-safe', async (command, args) => {
    calls.push({ command, args })
    return { stdout: '{"Reaped":[],"Conflicts":[]}', stderr: '' }
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.command, 'powershell.exe')
  assert.equal(calls[0]?.args.at(-1), 'ol-project-safe')
  assert.match(calls[0]?.args.at(-3) ?? '', /Get-CimInstance Win32_Process/)
  assert.doesNotMatch(calls[0]?.args.at(-3) ?? '', /ol-project-safe/)
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
      machineProvider: 'applehv',
      projectBaseDisk: '/tmp/openlink-project-vm-base.raw',
      cloneDisk: async (source, target) => { clones.push({ source, destination: target }) },
    })
    await driver.ensureMachine('openlink-project-base', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' })
    const init = calls.find((call) => call.args[0] === 'machine' && call.args[1] === 'init')
    const imageIndex = init?.args.indexOf('--image') ?? -1
    assert.ok(imageIndex >= 0)
    assert.match(init?.args[imageIndex + 1] ?? '', /openlink-podman-init-.+[\\/]placeholder\.raw$/)
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
      machineProvider: 'applehv',
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
      machineProvider: 'applehv',
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

test('resolves the native QEMU qcow2 disk from the isolated Podman data root', async () => {
  const root = await mkdtemp(`${tmpdir()}/openlink-podman-qemu-data-`)
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const destination = resolve(root, 'containers', 'podman', 'machine', 'qemu', `openlink-project-qemu-${architecture}.qcow2`)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, Buffer.alloc(4_096), { mode: 0o600 })
  const clones: Array<{ source: string; destination: string }> = []
  let inspectReads = 0
  try {
    const driver = new PodmanMachineDriver({
      run: async (_command, args) => {
        if (args[0] === 'machine' && args[1] === 'inspect') {
          inspectReads += 1
          if (inspectReads === 1) throw new Error('machine openlink-project-qemu does not exist')
          return { stdout: JSON.stringify([{ State: 'stopped' }]), stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
      bootstrap: false,
      machineProvider: 'qemu',
      projectBaseDisk: '/opt/openlink/project-vm/openlink-project-vm-base-amd64.qcow2',
      cloneDisk: async (source, target) => { clones.push({ source, destination: target }) },
    })
    await driver.ensureMachine('openlink-project-qemu', { cpus: 4, memoryMb: 8192, diskGb: 64, diskMode: 'thin' })
    assert.deepEqual(clones, [{ source: '/opt/openlink/project-vm/openlink-project-vm-base-amd64.qcow2', destination }])
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
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

test('rejects a materialized Golden Disk without publishing or leaving clone staging files', { skip: process.platform === 'win32' }, async () => {
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
      machineProvider: 'applehv',
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

test('publishes a verified Hyper-V differencing VHDX over the Podman placeholder', async () => {
  const root = await mkdtemp(`${tmpdir()}/openlink-project-hyperv-`)
  const source = `${root}/golden.vhdx`
  const destination = `${root}/project.vhdx`
  const logicalBytes = 64 * 1024 * 1024
  let published = false
  await writeFile(source, 'immutable-golden')
  await writeFile(destination, 'dynamic-placeholder')
  const run = async (_command: string, args: string[]): Promise<ProjectVmCommandResult> => {
    const script = args[args.indexOf('-Command') + 1] ?? ''
    const values = args.slice(args.indexOf('-Command') + 2)
    if (script.includes('New-VHD') && script.includes('-Differencing')) {
      await writeFile(values[0]!, 'differencing-child', { flag: 'wx' })
      return { stdout: '', stderr: '' }
    }
    if (script.includes('[IO.File]::Replace')) {
      await rename(values[1]!, values[2]!)
      await rename(values[0]!, values[1]!)
      published = true
      return { stdout: '', stderr: '' }
    }
    if (script.includes('Get-VHD')) {
      const path = values[0]!
      const differencing = path.includes('.diff-') || (resolve(path) === resolve(destination) && published)
      return {
        stdout: JSON.stringify({
          Path: path,
          VhdType: differencing ? 'Differencing' : 'Dynamic',
          VhdFormat: 'VHDX',
          Size: logicalBytes,
          FileSize: differencing ? 4 * 1024 * 1024 : resolve(path) === resolve(source) ? 16 * 1024 * 1024 : 2 * 1024 * 1024,
          ParentPath: differencing ? source : '',
          IsReadOnly: resolve(path) === resolve(source),
        }),
        stderr: '',
      }
    }
    throw new Error(`unexpected PowerShell operation: ${script}`)
  }

  try {
    await cloneThinHyperVProjectVmDisk(source, destination, run)
    assert.equal(await readFile(source, 'utf8'), 'immutable-golden')
    assert.equal(await readFile(destination, 'utf8'), 'differencing-child')
    assert.equal((await readdir(root)).some((entry) => entry.includes('.diff-') || entry.includes('.placeholder-')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a Hyper-V child whose immutable Golden parent does not match', async () => {
  const root = await mkdtemp(`${tmpdir()}/openlink-project-hyperv-parent-`)
  const source = `${root}/golden.vhdx`
  const destination = `${root}/project.vhdx`
  const logicalBytes = 64 * 1024 * 1024
  await writeFile(source, 'immutable-golden')
  await writeFile(destination, 'dynamic-placeholder')
  const run = async (_command: string, args: string[]): Promise<ProjectVmCommandResult> => {
    const script = args[args.indexOf('-Command') + 1] ?? ''
    const values = args.slice(args.indexOf('-Command') + 2)
    if (script.includes('New-VHD')) {
      await writeFile(values[0]!, 'invalid-child', { flag: 'wx' })
      return { stdout: '', stderr: '' }
    }
    if (script.includes('Get-VHD')) {
      const path = values[0]!
      const differencing = path.includes('.diff-')
      return {
        stdout: JSON.stringify({
          Path: path,
          VhdType: differencing ? 'Differencing' : 'Dynamic',
          VhdFormat: 'VHDX',
          Size: logicalBytes,
          FileSize: 2 * 1024 * 1024,
          ParentPath: differencing ? `${root}/other-golden.vhdx` : '',
          IsReadOnly: resolve(path) === resolve(source),
        }),
        stderr: '',
      }
    }
    throw new Error('replace must not run for an invalid child')
  }
  try {
    await assert.rejects(() => cloneThinHyperVProjectVmDisk(source, destination, run), /failed parent, size or allocation verification/)
    assert.equal(await readFile(destination, 'utf8'), 'dynamic-placeholder')
    assert.equal((await readdir(root)).some((entry) => entry.includes('.diff-')), false)
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
