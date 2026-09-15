import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager, type ProjectRuntimeServiceInput } from '../src/project-runtime.js'
import { ProjectVmManager, type ProjectVmCommandResult, type ProjectVmMachineDriver, type ProjectVmPortForward } from '../src/project-vm.js'

const projectSupabaseResult = (command: string, args: string[]): ProjectVmCommandResult | undefined => {
  if (command !== 'sudo' || args[0] !== '-n' || args[1] !== '/var/lib/openlink/project-supabase-runtime') return undefined
  const action = args[2]
  const option = (name: string) => args[args.indexOf(name) + 1]
  if (action === 'ensure') return { stdout: JSON.stringify({ projectId: option('--project-id'), url: `http://127.0.0.1:${option('--gateway-port')}`, publishableKey: 'sb_publishable_test_12345678', anonKey: 'header.payload.signature', revision: 'self-hosted/v0.8.0' }), stderr: '' }
  if (action === 'status') return { stdout: JSON.stringify({ projectId: option('--project-id'), status: 'ready', observedRevision: 'self-hosted/v0.8.0', gatewayPort: Number(option('--gateway-port')), databasePort: Number(option('--database-port')), poolerPort: Number(option('--pooler-port')) }), stderr: '' }
  if (action === 'public') return { stdout: JSON.stringify({ projectId: option('--project-id'), url: `http://127.0.0.1:${option('--gateway-port')}`, publishableKey: 'sb_publishable_test_12345678', anonKey: 'header.payload.signature', revision: 'self-hosted/v0.8.0' }), stderr: '' }
  if (action === 'manage') return { stdout: JSON.stringify({ operation: option('--operation'), tables: [{ schema: 'public', name: 'tasks', kind: 'BASE TABLE' }] }), stderr: '' }
  if (action === 'studio-proxy') return { stdout: JSON.stringify({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bodyBase64: Buffer.from(`<main>${option('--path')}</main>`).toString('base64url') }), stderr: '' }
  if (action === 'stop') return { stdout: JSON.stringify({ stopped: true }), stderr: '' }
  throw new Error(`unexpected Project Supabase controller action ${action}`)
}

const projectSupabaseRunInMachine = async (_machine: string, command: string, args: string[] = []): Promise<ProjectVmCommandResult> => projectSupabaseResult(command, args) ?? { stdout: '', stderr: '' }

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
    if (podmanArgs?.[0] === 'ps' && podmanArgs.includes('label=opensandbox.io/id')) return { stdout: 'sessionmain\n', stderr: '' }
    if (podmanArgs?.[0] === 'ps' && podmanArgs.includes('label=opensandbox.io/egress-sidecar-for')) return { stdout: 'sessionegress\n', stderr: '' }
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
    ports: { opensandbox: 51000, browserHost: 52000, codeServer: 53000, supabaseGateway: 54000, supabaseDatabase: 55000, supabasePooler: 56000 },
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
  assert.equal(calls.some((call) => call.args.includes('rm') && call.args.includes('sessionmain')), false,
    'replacing the durable OpenSandbox control plane must preserve live session workloads')
  assert.ok(calls.some((call) => call.args.includes('update') && call.args.includes('unless-stopped') && call.args.includes('sessionmain')))
  assert.ok(calls.some((call) => call.args.includes('update') && call.args.includes('unless-stopped') && call.args.includes('sessionegress')))
  const restoredSessions = calls.filter((call) => call.args.includes('start') && (call.args.includes('sessionmain') || call.args.includes('sessionegress')))
  assert.equal(restoredSessions.length, 2)
  assert.ok(restoredSessions[0]?.args.includes('sessionegress'), 'the egress sidecar must start before the Agent container')
  assert.ok(restoredSessions[1]?.args.includes('sessionmain'))
  const opensandboxRun = calls.find((call) => call.args.includes('run') && call.args.includes('openlink/opensandbox-server:dev'))
  assert.ok(opensandboxRun)
  assert.equal(opensandboxRun?.args[opensandboxRun.args.indexOf('--user') + 1], '0:0')
  assert.equal(opensandboxRun?.args[opensandboxRun.args.indexOf('--security-opt') + 1], 'label=disable')
  assert.ok(opensandboxRun?.args.some((arg) => arg === '/run/user/1000/podman/podman.sock:/var/run/docker.sock:rw'))
  const configEnv = opensandboxRun?.args.find((arg) => arg.startsWith('OPENLINK_OPENSANDBOX_CONFIG_B64='))
  assert.ok(configEnv)
  assert.match(Buffer.from(configEnv!.slice('OPENLINK_OPENSANDBOX_CONFIG_B64='.length), 'base64').toString('utf8'), /userns_mode = "keep-id"/)
})

test('resumes definition-identical Project VM services after a VM restart without treating shutdown signals as corruption', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const containers = new Map<string, { imageId: string; configHash: string }>()
  let secondEnsure = false
  const imageByContainer = new Map([
    ['openlink-project-2c51ca263cd04cb4-opensandbox', 'openlink/opensandbox-server:dev'],
    ['openlink-project-2c51ca263cd04cb4-browser', 'openlink/browser-host:dev'],
    ['openlink-project-2c51ca263cd04cb4-code-server', 'openlink/code-server:dev'],
  ])
  const imageId = (image: string) => `sha256:${Buffer.from(image).toString('hex').slice(0, 32)}`
  const runInMachine = async (_machine: string, command: string, args: string[] = []): Promise<ProjectVmCommandResult> => {
    calls.push({ command, args })
    const podmanArgs = command === 'podman' ? args : null
    if (command === 'id' && args[0] === '-u') return { stdout: '1000\n', stderr: '' }
    if (command === 'id' && args[0] === '-g') return { stdout: '1000\n', stderr: '' }
    if (podmanArgs?.[0] === 'image' && podmanArgs[1] === 'exists') return { stdout: 'true\n', stderr: '' }
    if (podmanArgs?.[0] === 'container' && podmanArgs[1] === 'inspect') {
      if (containers.has(podmanArgs[2] ?? '')) return { stdout: '{}\n', stderr: '' }
      throw new Error('container does not exist')
    }
    if (podmanArgs?.[0] === 'image' && podmanArgs[1] === 'inspect') return { stdout: `${imageId(podmanArgs.at(-1) ?? '')}\n`, stderr: '' }
    if (podmanArgs?.[0] === 'inspect' && podmanArgs[1] === '--format') {
      const name = podmanArgs.at(-1) ?? ''
      const container = containers.get(name)
      if (podmanArgs[2] === '{{json .State}}') return { stdout: `${JSON.stringify({ Status: secondEnsure ? 'exited' : 'running', ExitCode: 137, Error: '' })}\n`, stderr: '' }
      if (podmanArgs[2] === '{{.Image}}') return { stdout: `${container?.imageId ?? ''}\n`, stderr: '' }
      if (podmanArgs[2]?.includes('io.openlink.project-runtime-config')) return { stdout: `${container?.configHash ?? ''}\n`, stderr: '' }
    }
    if (podmanArgs?.[0] === 'run') {
      const name = podmanArgs[podmanArgs.indexOf('--name') + 1] ?? ''
      const label = podmanArgs[podmanArgs.indexOf('--label') + 1] ?? ''
      const image = imageByContainer.get(name) ?? ''
      containers.set(name, { imageId: imageId(image), configHash: label.split('=').at(-1) ?? '' })
    }
    return { stdout: '', stderr: '' }
  }
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine,
    forwardPort: async (_machine, remotePort) => ({ localPort: remotePort, close: async () => undefined }),
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const input: ProjectRuntimeServiceInput = {
    projectId: '2c51ca26-3cd0-4cb4-896d-2061de06098c',
    machineName: 'olp-test',
    workspacePath: '/home/core/openlink/projects/test/workspace',
    sessionStorageRoot: '/home/core/openlink/projects/test/workspace/.openlink/sessions',
    ports: { opensandbox: 51000, browserHost: 52000, codeServer: 53000, supabaseGateway: 54000, supabaseDatabase: 55000, supabasePooler: 56000 },
    opensandboxApiKey: 'sandbox-key', browserApiToken: 'browser-token', browserTokenSecret: 'browser-secret',
    browserAllowedOrigins: 'http://localhost:3000',
    opensandboxImage: 'openlink/opensandbox-server:dev', browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev', egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev', agentRpcWorkerImage: 'openlink/agent-rpc-worker:dev',
    codeServerImage: 'openlink/code-server:dev',
  }
  const driver = new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: false })

  await driver.ensureServices(input)
  const created = calls.filter((call) => call.command === 'podman' && call.args[0] === 'run')
  assert.equal(created.length, 3)
  for (const call of created) {
    assert.deepEqual(call.args.slice(call.args.indexOf('--restart'), call.args.indexOf('--restart') + 2), ['--restart', 'unless-stopped'])
  }

  calls.length = 0
  secondEnsure = true
  await driver.ensureServices(input)
  const started = calls.filter((call) => call.command === 'podman' && call.args[0] === 'start').map((call) => call.args[1]).sort()
  assert.deepEqual(started, [...imageByContainer.keys()].sort())
  assert.equal(calls.some((call) => call.command === 'podman' && call.args[0] === 'rm'), false)
  assert.equal(calls.some((call) => call.command === 'podman' && call.args[0] === 'run'), false)
})

test('transient health timeout preserves active worker endpoints and tunnels', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-health-timeout-'))
  let provisions = 0
  let closedForwards = 0
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: projectSupabaseRunInMachine,
    forwardPort: async (_machine, remotePort) => ({ localPort: remotePort, close: async () => { closedForwards++ } }),
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const runtime = new ProjectRuntimeManager({
    stateRoot,
    vmManager: new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' }),
    machineDriver,
    serviceDriver: { ensureServices: async () => { provisions++ }, stopServices: async () => {}, removeServices: async () => {} },
    opensandboxImage: 'test/opensandbox', browserHostImage: 'test/browser', execdImage: 'test/execd',
    egressImage: 'test/egress', agentWorkerImage: 'test/worker', hostPortAvailable: async () => true, healthCheckIntervalMs: 0,
  })
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  const originalFetch = globalThis.fetch
  try {
    const first = await runtime.ensure(projectId, 'thin')
    globalThis.fetch = async () => { throw new DOMException('probe timed out', 'TimeoutError') }
    await assert.rejects(runtime.ensure(projectId), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'PROJECT_BACKEND_UNAVAILABLE')
    assert.equal(provisions, 1, 'a probe timeout must not reprovision a healthy VM')
    assert.equal(closedForwards, 0, 'existing Worker handles still own these endpoints')
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/health')) return new Response('{}')
      throw new DOMException('optional Browser is slow', 'TimeoutError')
    }
    assert.equal(await runtime.ensure(projectId, undefined, 'agent'), first, 'Agent must not wait for optional Browser or Studio health')
    globalThis.fetch = async () => new Response('{}')
    assert.equal(await runtime.ensure(projectId), first)
  } finally {
    globalThis.fetch = originalFetch
    await runtime.close({ stopRuntimes: false })
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('allocates durable non-colliding Project VM service ports', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-'))
  const allocations: Array<{ projectId: string; ports: { opensandbox: number; browserHost: number; codeServer: number } }> = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: projectSupabaseRunInMachine,
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
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
    projectPortRangeSize: 10,
    hostPortAvailable: async () => true,
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
    assert.deepEqual(allocations.map((allocation) => allocation.ports.opensandbox).sort(), [51_000, 51_001])
    assert.deepEqual(allocations.map((allocation) => allocation.ports.codeServer).sort(), [53_000, 53_001])
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

test('reassigns a persisted Project port bundle when a host port is occupied', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-port-conflict-'))
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  const allocations: ProjectRuntimeServiceInput[] = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: projectSupabaseRunInMachine,
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  try {
    await mkdir(resolve(stateRoot, 'projects', projectId), { recursive: true })
    await writeFile(resolve(stateRoot, 'projects', projectId, 'ports.json'), JSON.stringify({
      projectId,
      opensandbox: 51_000,
      browserHost: 52_000,
      codeServer: 53_000,
      supabaseGateway: 54_000,
      supabaseDatabase: 55_000,
      supabasePooler: 56_000,
      allocatedAt: '2026-08-31T00:00:00.000Z',
    }))
    const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
    const runtime = new ProjectRuntimeManager({
      stateRoot,
      vmManager,
      machineDriver,
      serviceDriver: {
        supportsEgress: true,
        ensureServices: async (input) => { allocations.push(input) },
        stopServices: async () => undefined,
        removeServices: async () => undefined,
      },
      opensandboxImage: 'openlink/opensandbox-server:dev',
      browserHostImage: 'openlink/browser-host:dev',
      execdImage: 'openlink/opensandbox-execd:dev',
      egressImage: 'openlink/opensandbox-egress:dev',
      agentWorkerImage: 'openlink/agent-worker:dev',
      projectPortBase: 51_000,
      projectPortRangeSize: 3,
      hostPortAvailable: async (port) => port !== 53_000,
    })

    await runtime.ensure(projectId, 'thin')

    assert.equal(allocations.length, 1)
    assert.deepEqual(allocations[0]?.ports, {
      opensandbox: 51_001,
      browserHost: 52_001,
      codeServer: 53_001,
      supabaseGateway: 54_001,
      supabaseDatabase: 55_001,
      supabasePooler: 56_001,
    })
    assert.match(await readFile(resolve(stateRoot, 'projects', projectId, 'ports.json'), 'utf8'), /"codeServer":53001/)
    await runtime.close()
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('fails clearly when the configured Project port range is exhausted', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-port-exhausted-'))
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: projectSupabaseRunInMachine,
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  try {
    const vmManager = new ProjectVmManager({ stateRoot, machineDriver })
    const runtime = new ProjectRuntimeManager({
      stateRoot,
      vmManager,
      machineDriver,
      serviceDriver: { ensureServices: async () => undefined, stopServices: async () => undefined, removeServices: async () => undefined },
      opensandboxImage: 'openlink/opensandbox-server:dev',
      browserHostImage: 'openlink/browser-host:dev',
      execdImage: 'openlink/opensandbox-execd:dev',
      egressImage: 'openlink/opensandbox-egress:dev',
      agentWorkerImage: 'openlink/agent-worker:dev',
      projectPortBase: 51_000,
      projectPortRangeSize: 1,
      hostPortAvailable: async () => false,
    })

    await assert.rejects(
      () => runtime.ensure('2c51ca26-3cd0-4cb4-896d-2061de06098c', 'thin'),
      /Project runtime port range is exhausted/,
    )
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('synchronizes the Project Supabase controller from the supervisor workspace root', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-controller-'))
  const originalWorkspaceRoot = process.env.OPENLINK_AGENT_WORKSPACE_ROOT
  const copied: string[] = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    copyToMachine: async (_machine, source) => { copied.push(source) },
    runInMachine: projectSupabaseRunInMachine,
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
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
  process.env.OPENLINK_AGENT_WORKSPACE_ROOT = resolve('/tmp/openlink-supervisor-root')
  try {
    await runtime.ensure('2c51ca26-3cd0-4cb4-896d-2061de06098c', 'thin')
    assert.deepEqual(copied, [
      resolve('/tmp/openlink-supervisor-root/services/agent-host/project-supabase-runtime.mjs'),
      resolve('/tmp/openlink-supervisor-root/scripts/lib/project-supabase-bundle.mjs'),
    ])
  } finally {
    if (originalWorkspaceRoot === undefined) delete process.env.OPENLINK_AGENT_WORKSPACE_ROOT
    else process.env.OPENLINK_AGENT_WORKSPACE_ROOT = originalWorkspaceRoot
    await runtime.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('preserves resident Project VMs across an Agent Host restart and restores them on startup', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-resident-'))
  const machineCalls: string[] = []
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async (name) => { machineCalls.push(`ensure:${name}`) },
    bootstrapToolchain: async () => undefined,
    runInMachine: projectSupabaseRunInMachine,
    forwardPort: async (_machine, remotePort) => ({ localPort: remotePort, close: async () => undefined }),
    stopMachine: async (name) => { machineCalls.push(`stop:${name}`) },
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
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

test('serves Project Supabase management from a ready persisted VM without re-provisioning project services', async () => {
  const stateRoot = await mkdtemp(join('/tmp', 'openlink-project-runtime-management-'))
  let serviceEnsures = 0
  const machineDriver: ProjectVmMachineDriver = {
    ensureMachine: async () => undefined,
    bootstrapToolchain: async () => undefined,
    runInMachine: projectSupabaseRunInMachine,
    forwardPort: async (_machine, remotePort) => ({ localPort: remotePort, close: async () => undefined }),
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machinePrefix: 'olp', machineDriver, guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
  const options = {
    stateRoot, vmManager, machineDriver,
    serviceDriver: { supportsEgress: true, ensureServices: async () => { serviceEnsures += 1 }, stopServices: async () => undefined, removeServices: async () => undefined },
    opensandboxImage: 'openlink/opensandbox-server:dev', browserHostImage: 'openlink/browser-host:dev', execdImage: 'openlink/opensandbox-execd:dev', egressImage: 'openlink/opensandbox-egress:dev', agentWorkerImage: 'openlink/agent-worker:dev',
  }
  const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'
  try {
    const first = new ProjectRuntimeManager(options)
    await first.ensure(projectId, 'thin')
    await first.close({ stopRuntimes: false })
    const second = new ProjectRuntimeManager(options)
    const descriptor = await second.describeSupabase(projectId)
    const result = await second.manageSupabase(projectId, { operation: 'tables' })
    const studio = await second.proxySupabaseStudio(projectId, { method: 'GET', path: '/projects/default/editor' })
    assert.equal(serviceEnsures, 1)
    assert.equal(descriptor?.revision, 'self-hosted/v0.8.0')
    assert.deepEqual(result.tables, [{ schema: 'public', name: 'tasks', kind: 'BASE TABLE' }])
    assert.equal(studio.status, 200)
    assert.equal(studio.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(Buffer.from(studio.bodyBase64, 'base64url').toString('utf8'), '<main>/projects/default/editor</main>')
    await second.close()
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
      return projectSupabaseResult(command, args) ?? { stdout: '', stderr: '' }
    },
    forwardPort: async (_machine, remotePort) => ({ localPort: remotePort, close: async () => undefined }),
    stopMachine: async () => undefined,
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
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
      runtime.listGitVersions(projectId),
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
    runInMachine: projectSupabaseRunInMachine,
    stopMachine: async (name) => { stopped.push(name) },
    removeMachine: async () => undefined,
  }
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
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
  const vmManager = new ProjectVmManager({ stateRoot, machineDriver, machinePrefix: 'olp', guestWorkspaceRoot: '/var/lib/openlink/test-projects' })
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
