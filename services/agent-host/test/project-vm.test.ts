import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { ProjectVmManager, PodmanMachineDriver, type ProjectVmCommandResult } from '../src/project-vm.js'

const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'

test('creates a durable project machine and bootstraps the development toolchain', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  let inspected = false
  const run = async (command: string, args: string[]): Promise<ProjectVmCommandResult> => {
    calls.push({ command, args })
    if (args[0] === 'machine' && args[1] === 'inspect' && !inspected) {
      inspected = true
      throw new Error('machine openlink-project-2c51ca263cd04cb4896d2061 does not exist')
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
    const descriptor = await manager.ensure(projectId)
    assert.equal(descriptor.status, 'ready')
    assert.equal(descriptor.machineName, 'openlink-project-2c51ca263cd04cb4896d2061')
    assert.match(await readFile(`${root}/projects/${projectId}/runtime.json`, 'utf8'), /"status":"ready"/)
    assert.deepEqual(calls[0]?.args.slice(0, 3), ['machine', 'inspect', descriptor.machineName])
    assert.deepEqual(calls[1]?.args.slice(0, 2), ['machine', 'init'])
    const bootstrap = calls.find((call) => call.args[0] === 'machine' && call.args[1] === 'ssh')
    assert.ok(bootstrap)
    assert.match(bootstrap.args.at(-1) ?? '', /git nodejs npm python3/)
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
