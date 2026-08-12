import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager, type ProjectRuntimeServiceInput } from '../src/project-runtime.js'
import { ProjectVmManager, type ProjectVmCommandResult, type ProjectVmMachineDriver, type ProjectVmPortForward } from '../src/project-vm.js'

test('recreates failed Project VM service containers instead of restarting stale state', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const stale = new Set([
    'openlink-project-2c51ca263cd04cb4-opensandbox',
    'openlink-project-2c51ca263cd04cb4-browser',
  ])
  const expectedStale = [...stale]
  const runInMachine = async (_machine: string, command: string, args: string[] = []): Promise<ProjectVmCommandResult> => {
    calls.push({ command, args })
    const podmanArgs = command === 'sudo' && args[0] === '-n' && args[1] === 'podman' ? args.slice(2) : command === 'podman' ? args : null
    if (command === 'id' && args[0] === '-u') return { stdout: '1000\n', stderr: '' }
    if (command === 'id' && args[0] === '-g') return { stdout: '1000\n', stderr: '' }
    if (podmanArgs?.[0] === 'image' && podmanArgs[1] === 'exists') return { stdout: 'true\n', stderr: '' }
    if (podmanArgs?.[0] === 'network' && podmanArgs[1] === 'inspect') throw new Error('network does not exist')
    if (podmanArgs?.[0] === 'container' && podmanArgs[1] === 'inspect') {
      if (stale.has(podmanArgs[2] ?? '')) return { stdout: '{}\n', stderr: '' }
      throw new Error('container does not exist')
    }
    if (podmanArgs?.[0] === 'inspect' && podmanArgs[1] === '--format' && podmanArgs[2] === '{{.State.Status}}') return { stdout: 'exited\n', stderr: '' }
    if (podmanArgs?.[0] === 'inspect' && podmanArgs[1] === '--format' && podmanArgs[2] === '{{.Image}}') return { stdout: 'old-image\n', stderr: '' }
    if (podmanArgs?.[0] === 'image' && podmanArgs[1] === 'inspect') return { stdout: 'new-image\n', stderr: '' }
    if (podmanArgs?.[0] === 'rm') stale.delete(podmanArgs.at(-1) ?? '')
    return { stdout: '', stderr: '' }
  }
  const forwardPort = async (_machine: string, remotePort: number): Promise<ProjectVmPortForward> => ({
    localPort: remotePort,
    close: async () => undefined,
  })
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine,
    forwardPort,
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const input: ProjectRuntimeServiceInput = {
    projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
    machineName: 'olp-test',
    workspacePath: '/home/core/openlink/projects/test/workspace',
    sessionStorageRoot: '/home/core/openlink/projects/test/workspace/.openlink/sessions',
    ports: { opensandbox: 51000, browserHost: 52000, codeServer: 53000 },
    opensandboxApiKey: 'sandbox-key',
    browserApiToken: 'browser-token',
    browserTokenSecret: 'browser-secret',
    browserAllowedOrigins: 'http://localhost:3000',
    opensandboxImage: 'openlink/opensandbox-server:dev',
    browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev',
    egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev',
    agentRpcWorkerImage: 'openlink/agent-rpc-worker:dev',
    codeServerImage: 'openlink/code-server:dev',
  }

  // Exercise the same rootless Podman path used by the local AppleHV Project
  // VM. Remote Linux VMs opt into rootful mode separately.
  await new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: false }).ensureServices(input)

  const removed = calls
    .filter((call) => (call.command === 'podman' && call.args[0] === 'rm') || (call.command === 'sudo' && call.args[0] === '-n' && call.args[1] === 'podman' && call.args[2] === 'rm'))
    .map((call) => call.args.at(-1))
  assert.deepEqual(removed.sort(), expectedStale.sort())
  const recreated = calls
    .filter((call) => (call.command === 'podman' && call.args[0] === 'run') || (call.command === 'sudo' && call.args[0] === '-n' && call.args[1] === 'podman' && call.args[2] === 'run'))
    .map((call) => call.args[call.args.indexOf('--name') + 1])
  assert.equal(recreated.length, 3)
  assert.ok(recreated.includes('openlink-project-2c51ca263cd04cb4-opensandbox'))
  assert.ok(recreated.includes('openlink-project-2c51ca263cd04cb4-browser'))
  assert.ok(recreated.includes('openlink-project-2c51ca263cd04cb4-code-server'))
  const opensandboxRun = calls.find((call) => call.args.includes('run') && call.args.includes('openlink/opensandbox-server:dev'))
  assert.ok(opensandboxRun)
  assert.equal(opensandboxRun?.args[opensandboxRun.args.indexOf('--user') + 1], '0:0')
  assert.equal(opensandboxRun?.args[opensandboxRun.args.indexOf('--security-opt') + 1], 'label=disable')
  assert.ok(opensandboxRun?.args.some((arg) => arg === '/run/user/1000/podman/podman.sock:/var/run/docker.sock:rw'))
  const configEnv = opensandboxRun?.args.find((arg) => arg.startsWith('OPENLINK_OPENSANDBOX_CONFIG_B64='))
  assert.ok(configEnv)
  assert.match(Buffer.from(configEnv!.slice('OPENLINK_OPENSANDBOX_CONFIG_B64='.length), 'base64').toString('utf8'), /userns_mode = "keep-id"/)
})

test('allocates durable non-colliding Project VM service ports', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-'))
  const allocations: Array<{ projectId: string; ports: { opensandbox: number; browserHost: number; codeServer: number } }> = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: async () => ({ stdout: '', stderr: '' }),
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: `${stateRoot}/guest` })
  const serviceDriver = {
    supportsEgress: true,
    ensureServices: async (input: ProjectRuntimeServiceInput) => { allocations.push({ projectId: input.projectId, ports: input.ports }) },
    stopServices: async () => undefined,
    removeServices: async () => undefined,
  }
  const runtime = new ProjectRuntimeManager({
    stateRoot,
    vmManager,
    machineDriver,
    serviceDriver,
    opensandboxImage: 'openlink/opensandbox-server:dev',
    browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev',
    egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev',
    projectPortBase: 51_000,
  })
  const first = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  const second = '3ef1d54c-7a74-4a04-88b1-cfa94f61fafb'
  try {
    await Promise.all([runtime.ensure(first, 'thin'), runtime.ensure(second, 'thick')])
    assert.equal(allocations.length, 2)
    assert.notEqual(allocations[0]?.ports.opensandbox, allocations[1]?.ports.opensandbox)
    assert.notEqual(allocations[0]?.ports.browserHost, allocations[1]?.ports.browserHost)
    assert.notEqual(allocations[0]?.ports.opensandbox, allocations[1]?.ports.browserHost)
    assert.notEqual(allocations[1]?.ports.opensandbox, allocations[0]?.ports.browserHost)
    assert.notEqual(allocations[0]?.ports.codeServer, allocations[1]?.ports.codeServer)
    assert.notEqual(allocations[0]?.ports.codeServer, allocations[1]?.ports.browserHost)
    assert.notEqual(allocations[1]?.ports.codeServer, allocations[0]?.ports.browserHost)
    assert.match(await readFile(`${stateRoot}/projects/${first}/runtime.json`, 'utf8'), /"diskMode":"thin"/)
    assert.match(await readFile(`${stateRoot}/projects/${second}/runtime.json`, 'utf8'), /"diskMode":"thick"/)
    assert.match(await readFile(`${stateRoot}/projects/${first}/ports.json`, 'utf8'), new RegExp(first))
    assert.equal(await runtime.hasPersistedRuntime(first), true)
    assert.equal(await runtime.hasPersistedRuntime('4f7f3d7a-8c4c-4e77-9b2f-8e5b7c8d6a10'), false)
    await runtime.stop(first)
    // An explicit stop must leave a terminal marker so a later browser
    // cleanup request does not boot this VM again merely to find no session.
    assert.equal(await runtime.hasPersistedRuntime(first), false)
    await runtime.close()
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('preserves resident Project VMs across an Agent Host restart and restores them on startup', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-resident-'))
  const machineCalls: string[] = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async (name) => { machineCalls.push(`ensure:${name}`) },
    bootstrapToolchain: async () => undefined,
    runInMachine: async () => ({ stdout: '', stderr: '' }),
    forwardPort: async (_machine, remotePort) => ({ localPort: remotePort, close: async () => undefined }),
    stopMachine: async (name) => { machineCalls.push(`stop:${name}`) },
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: `${stateRoot}/guest` })
  const serviceDriver = {
    supportsEgress: true,
    ensureServices: async () => undefined,
    stopServices: async () => undefined,
    removeServices: async () => undefined,
  }
  const createRuntime = () => new ProjectRuntimeManager({
    stateRoot,
    vmManager,
    machineDriver,
    serviceDriver,
    opensandboxImage: 'openlink/opensandbox-server:dev',
    browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev',
    egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev',
  })
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  try {
    const first = createRuntime()
    await first.ensure(projectId, 'thin')
    await first.close({ stopRuntimes: false })
    assert.equal(machineCalls.some((call) => call.startsWith('stop:')), false)
    assert.match(await readFile(`${stateRoot}/projects/${projectId}/runtime.json`, 'utf8'), /"status":"ready"/)

    const second = createRuntime()
    await second.restorePersistedRuntimes()
    assert.equal(machineCalls.filter((call) => call.startsWith('ensure:')).length, 2)
    await second.close()
    assert.equal(machineCalls.filter((call) => call.startsWith('stop:')).length, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('initializes a Project workspace Git baseline exactly once before agent use', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-git-'))
  const calls: Array<{ machine: string; command: string; args: string[] }> = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: async (machine, command, args = []) => {
      calls.push({ machine, command, args })
      return { stdout: '', stderr: '' }
    },
    forwardPort: async (_machine, remotePort) => ({ localPort: remotePort, close: async () => undefined }),
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: `${stateRoot}/guest` })
  const runtime = new ProjectRuntimeManager({
    stateRoot,
    vmManager,
    machineDriver,
    serviceDriver: { supportsEgress: true, ensureServices: async () => undefined, stopServices: async () => undefined, removeServices: async () => undefined },
    opensandboxImage: 'openlink/opensandbox-server:dev',
    browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev',
    egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev',
  })
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  try {
    await runtime.ensure(projectId, 'thin')
    await Promise.all([
      runtime.ensureProjectGitRepository(projectId),
      runtime.ensureProjectGitRepository(projectId),
    ])
    const gitInitializers = calls.filter((call) => call.command === 'sh' && call.args.includes('openlink-project-git-init'))
    assert.equal(gitInitializers.length, 1)
    assert.equal(gitInitializers[0]?.machine, vmManager.machineName(projectId))
    assert.equal(gitInitializers[0]?.args.at(-1), vmManager.workspacePath(projectId))
    assert.match(gitInitializers[0]?.args[1] ?? '', /git -C "\$workspace" init --initial-branch=main/)
    assert.match(gitInitializers[0]?.args[1] ?? '', /commit --allow-empty -m "chore: initialize OpenLink project"/)
    assert.match(gitInitializers[0]?.args[1] ?? '', /\.openlink\//)
  } finally {
    await runtime.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('does not leak an active runtime when service shutdown fails', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-cleanup-'))
  const stopped: string[] = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    stopMachine: async (name) => { stopped.push(name) },
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: `${stateRoot}/guest` })
  const serviceDriver = {
    supportsEgress: true,
    ensureServices: async () => undefined,
    stopServices: async () => { throw new Error('podman stop failed') },
    removeServices: async () => undefined,
  }
  const runtime = new ProjectRuntimeManager({
    stateRoot,
    vmManager,
    machineDriver,
    serviceDriver,
    opensandboxImage: 'openlink/opensandbox-server:dev',
    browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev',
    egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev',
  })
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  try {
    await runtime.ensure(projectId, 'thin')
    await assert.rejects(runtime.stop(projectId), /podman stop failed/)
    assert.deepEqual(stopped, [vmManager.machineName(projectId)])
    assert.equal(runtime.getActive(projectId), undefined)
    // A failed service shutdown is retained as an error marker so a later
    // cleanup request can rehydrate the machine and retry it.
    assert.equal(await runtime.hasPersistedRuntime(projectId), true)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('cleans a Project VM when session storage preparation fails', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-storage-failure-'))
  const stopped: string[] = []
  let guestCommands = 0
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: async (_name, command) => {
      guestCommands += 1
      // ProjectVmManager uses the first two commands for the durable project
      // workspace. The runtime manager's session-root mkdir must also be
      // covered by its provisioning cleanup path.
      if (guestCommands === 3 && command === 'mkdir') throw new Error('session storage unavailable')
      return { stdout: '', stderr: '' }
    },
    stopMachine: async (name) => { stopped.push(name) },
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: `${stateRoot}/guest` })
  let serviceEnsures = 0
  const serviceDriver = {
    supportsEgress: true,
    ensureServices: async () => { serviceEnsures += 1 },
    stopServices: async () => undefined,
    removeServices: async () => undefined,
  }
  const runtime = new ProjectRuntimeManager({
    stateRoot, vmManager, machineDriver, serviceDriver,
    opensandboxImage: 'openlink/opensandbox-server:dev',
    browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev',
    egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev',
  })
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  try {
    await assert.rejects(runtime.ensure(projectId, 'thin'), /session storage unavailable/)
    assert.equal(serviceEnsures, 0)
    assert.deepEqual(stopped, [vmManager.machineName(projectId)])
    assert.equal(runtime.getActive(projectId), undefined)
    assert.equal(await runtime.hasPersistedRuntime(projectId), false)
  } finally {
    await runtime.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
