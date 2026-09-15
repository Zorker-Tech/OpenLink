import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { configureBundledPodmanRuntime, ensureBundledPodmanPlatformEngine, platformEngineIdentity } from '../lib/bundled-podman-runtime.mjs'

const environmentKeys = [
  'OPENLINK_PODMAN_COMMAND',
  'CONTAINERS_HELPER_BINARY_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CONTAINERS_MACHINE_PROVIDER',
  'CONTAINERS_CONF',
  'CONTAINERS_POLICY',
  'PODMAN_CONNECTIONS_CONF',
]

test('keeps Podman machine connections in the containers config directory', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openlink-podman-runtime-'))
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
  try {
    for (const key of environmentKeys) delete process.env[key]
    await configureBundledPodmanRuntime(root)
    assert.equal(
      process.env.PODMAN_CONNECTIONS_CONF,
      resolve(root, '.openlink-runtime/podman-config/containers/podman-connections.json'),
    )

    const supervisor = await readFile(new URL('../dev-browser.mjs', import.meta.url), 'utf8')
    assert.match(supervisor, /const podmanConnections = resolve\(podmanContainersRoot, 'podman-connections\.json'\)/)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('platform engine identity is deterministic per installation and contains no checkout path', () => {
  const first = platformEngineIdentity('/opt/openlink/state')
  const same = platformEngineIdentity('/opt/openlink/state')
  const other = platformEngineIdentity('/srv/openlink/state')
  assert.deepEqual(first, same)
  assert.notEqual(first.machineName, other.machineName)
  assert.match(first.machineName, /^openlink-platform-[a-f0-9]{12}$/)
  assert.equal(first.guestReleaseRoot.includes('/opt/openlink'), false)
})

test('macOS startup reuses and starts the dynamically identified platform engine', async () => {
  const calls = []
  const env = {}
  const product = await mkdtemp(resolve(tmpdir(), 'openlink-platform-reuse-'))
  const stateRoot = resolve(product, '.openlink-runtime')
  const identity = platformEngineIdentity(stateRoot)
  const execFile = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'machine' && args[1] === 'inspect') {
      return { stdout: JSON.stringify([{ Name: identity.machineName, State: 'stopped', Mounts: [
        { Source: product, Target: identity.guestReleaseRoot, Type: 'virtiofs' },
        { Source: stateRoot, Target: identity.guestStateRoot, Type: 'virtiofs' },
      ], ImagePath: { Path: resolve(stateRoot, 'disk.raw') } }]) }
    }
    if (args[0] === 'machine' && args[1] === 'list') return { stdout: '[]' }
    return { stdout: args[0] === 'info' ? '"6.2.0"\n' : '' }
  }

  const result = await ensureBundledPodmanPlatformEngine(product, {
    env,
    host: { platform: 'darwin', architecture: 'arm64', provider: 'applehv' },
    podman: resolve(product, 'podman'),
    execFile,
    startDirectAppleHv: async () => ({ apiSocket: resolve(product, 'podman-api.sock'), reused: true }),
  })

  assert.equal(result.machineName, identity.machineName)
  assert.equal(env.OPENLINK_DOCKER_COMMAND, resolve(product, 'podman'))
  assert.equal(env.CONTAINER_CONNECTION, undefined)
  assert.equal(env.CONTAINER_HOST, `unix://${resolve(product, 'podman-api.sock')}`)
  assert.equal(env.OPENLINK_ZOKERBASE_STACK_ROOT, `${identity.guestReleaseRoot}/backend/docker`)
  assert.deepEqual(calls.map((call) => call.slice(1, 4)), [
    ['machine', 'inspect', identity.machineName],
    ['info', '--format', '{{json .Version.Version}}'],
  ])
})

test('direct AppleHV startup does not inspect or stop foreign Podman machines', async () => {
  const product = await mkdtemp(resolve(tmpdir(), 'openlink-platform-conflict-'))
  const stateRoot = resolve(product, '.openlink-runtime')
  const identity = platformEngineIdentity(stateRoot)
  await ensureBundledPodmanPlatformEngine(product, {
      env: {},
      host: { platform: 'darwin', architecture: 'arm64', provider: 'applehv' },
      podman: resolve(product, 'podman'),
      execFile: async (_command, args) => {
        if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Name: identity.machineName, State: 'stopped', Mounts: [
          { Source: product, Target: identity.guestReleaseRoot, Type: 'virtiofs' },
          { Source: stateRoot, Target: identity.guestStateRoot, Type: 'virtiofs' },
        ], ImagePath: { Path: resolve(stateRoot, 'disk.raw') } }]) }
        assert.notEqual(args[1], 'stop')
        assert.notEqual(args[1], 'list')
        return { stdout: '"6.2.0"' }
      },
      startDirectAppleHv: async () => ({ apiSocket: resolve(product, 'podman-api.sock'), reused: true }),
    })
})
