#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { configureBundledPodmanRuntime } from './lib/bundled-podman-runtime.mjs'
import { readProjectSupabaseLock } from './lib/project-supabase-lock.mjs'
import { run, runCapture } from './lib/podman-builder.mjs'
import { packageManagerCommand, prependPath, resolveHostPlatform } from './lib/host-platform.mjs'
import { assertProjectVmArtifactManifest, projectVmArtifactContract } from './lib/project-vm-artifact.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
await configureBundledPodmanRuntime(root)
const host = resolveHostPlatform()
const artifactContract = projectVmArtifactContract({ host })

const podman = process.env.OPENLINK_PODMAN_COMMAND || resolve(root, '.openlink-runtime/toolchain/bin/podman')
const outputRoot = resolve(root, '.openlink-runtime/project-vm-base')
const manifest = JSON.parse(await readFile(resolve(outputRoot, 'manifest.json'), 'utf8'))
const disk = process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_DISK_IMAGE || resolve(outputRoot, manifest.disk || '')
const lock = await readProjectSupabaseLock(resolve(root, 'services/project-supabase/runtime.lock.json'))
const imageArtifacts = JSON.parse(await readFile(resolve(root, '.openlink-runtime/project-supabase/images', manifest.diskProjectSupabase?.architecture || '', 'manifest.json'), 'utf8'))
const machine = process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_MACHINE || `ol-supa-${Date.now().toString(36)}`
const projectId = process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_PROJECT_ID || randomUUID()
async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  assert.ok(Number.isSafeInteger(port) && port >= 1024, 'host did not allocate a usable validation port')
  return port
}
const allocatedPorts = new Set()
while (allocatedPorts.size < 3) allocatedPorts.add(await freeLoopbackPort())
const [allocatedGatewayPort, allocatedDatabasePort, allocatedPoolerPort] = allocatedPorts
const gatewayPort = Number(process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_GATEWAY_PORT || allocatedGatewayPort)
const databasePort = Number(process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_DATABASE_PORT || allocatedDatabasePort)
const poolerPort = Number(process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_POOLER_PORT || allocatedPoolerPort)
const expectedDiskLayout = artifactContract.diskLayout
const provider = process.env.CONTAINERS_MACHINE_PROVIDER || artifactContract.provider
const configRoot = process.env.XDG_CONFIG_HOME || resolve(root, '.openlink-runtime/podman-config')
const dataRoot = process.env.XDG_DATA_HOME || resolve(root, '.openlink-runtime/podman-data')
const helperRoot = process.env.CONTAINERS_HELPER_BINARY_DIR || resolve(root, '.openlink-runtime/toolchain/bin')
const environment = { ...process.env, XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: dataRoot, CONTAINERS_MACHINE_PROVIDER: provider, CONTAINERS_HELPER_BINARY_DIR: helperRoot, PATH: prependPath(helperRoot, process.env.PATH || '') }
Object.assign(process.env, {
  XDG_CONFIG_HOME: configRoot,
  XDG_DATA_HOME: dataRoot,
  CONTAINERS_MACHINE_PROVIDER: provider,
  CONTAINERS_HELPER_BINARY_DIR: helperRoot,
})
// Long-running machine operations (Golden Disk clone, boot, Supabase ensure) far
// exceed the default 2 minute spawn timeout, so every invocation uses a 1 hour
// ceiling mirroring the image builder's artifactOptions.
const commandOptions = { env: environment, timeout: 60 * 60 * 1000 }
const podmanArchitecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
const machineDisk = resolve(dataRoot, 'containers', 'podman', 'machine', provider, provider === 'hyperv' ? `${machine}-${podmanArchitecture}.vhdx` : `${machine}-${process.arch}.raw`)
const machineSpec = {
  cpus: Number(process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_CPUS || '6'),
  memoryMb: Number(process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_MEMORY_MB || '12288'),
  diskGb: Number(process.env.OPENLINK_PROJECT_SUPABASE_VALIDATION_DISK_GB || '64'),
  diskMode: 'thin',
}

process.stdout.write('[validate] building Agent Host production Project VM driver\n')
await run(packageManagerCommand('npm'), ['--prefix', resolve(root, 'services/agent-host'), 'run', 'build'], { cwd: root, env: process.env, timeout: 10 * 60 * 1000 })
const { PodmanMachineDriver, inspectHyperVVhd } = await import(pathToFileURL(resolve(root, 'services/agent-host/dist/src/project-vm.js')).href)
const machineDriver = new PodmanMachineDriver({
  command: podman,
  run: (command, args) => runCapture(command, args, commandOptions),
  bootstrap: false,
  rootfulPodman: true,
  projectBaseDisk: disk,
  machineProvider: provider,
  machineDiskPath: () => machineDisk,
  directAppleHv: provider === 'applehv',
  helperBinaryDirectory: helperRoot,
  preserveFailedMachine: process.env.OPENLINK_PROJECT_SUPABASE_KEEP_VALIDATION_VM === '1',
  ...(provider === 'applehv' ? {
    directStateRoot: resolve(root, '.openlink-runtime/project-supabase-validation/applehv'),
    directSocketRoot: resolve('/tmp', `openlink-supa-${process.pid}`),
  } : {}),
})

function machineCommand(command, args = []) { return machineDriver.runInMachine(machine, command, args) }
function machineResult(command, args = []) { return machineDriver.runInMachine(machine, command, args) }
function machineProbe(command, args = []) { return machineDriver.runInMachine(machine, command, args) }
function allocatedBytes(stats) {
  const value = Number(stats.blocks) * 512
  assert.ok(Number.isSafeInteger(value) && value >= 0, 'host filesystem must expose valid allocated-block accounting')
  return value
}
async function waitSsh() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try { await machineProbe('true'); return } catch { await new Promise((done) => setTimeout(done, 1_000)) }
  }
  throw new Error(`Validation Project VM ${machine} did not become reachable`)
}
async function waitForGuestBootChange(previousBootId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const current = (await machineProbe('cat', ['/proc/sys/kernel/random/boot_id'])).stdout.trim()
      if (/^[0-9a-f-]{36}$/i.test(current) && current !== previousBootId) return current
    } catch {}
    await new Promise((done) => setTimeout(done, 1_000))
  }
  throw new Error(`Validation Project VM ${machine} did not complete a guest reboot`)
}

assert.equal(manifest.schemaVersion, 2, 'Project VM manifest must be schemaVersion 2')
assert.equal(manifest.projectSupabase?.release, lock.release.tag)
assert.equal(manifest.diskProjectSupabase?.preloaded, true)
assert.equal(manifest.diskProjectSupabase?.images, lock.services.length)
assert.equal(manifest.diskLayout, expectedDiskLayout)
assert.equal(provider, artifactContract.provider, `Project Supabase hardware validation requires the native ${artifactContract.provider} Golden Disk provider`)
assertProjectVmArtifactManifest(manifest, artifactContract)
assert.ok((await stat(disk)).isFile(), `Golden Disk is missing: ${disk}`)

let created = false
try {
  const goldenStats = await stat(disk)
  const goldenVhd = provider === 'hyperv' ? await inspectHyperVVhd(disk, (command, args) => runCapture(command, args, commandOptions)) : undefined
  const goldenLogical = goldenVhd?.Size ?? goldenStats.size
  const goldenAllocated = goldenVhd?.FileSize ?? allocatedBytes(goldenStats)
  process.stdout.write(`[validate] machine ensure: production CoW clone (${manifest.diskProjectSupabase?.architecture}) → ${machine}\n`)
  await machineDriver.ensureMachine(machine, machineSpec)
  created = true
  const projectStats = await stat(machineDisk)
  const projectVhd = provider === 'hyperv' ? await inspectHyperVVhd(machineDisk, (command, args) => runCapture(command, args, commandOptions)) : undefined
  const projectLogical = projectVhd?.Size ?? projectStats.size
  const projectAllocated = projectVhd?.FileSize ?? allocatedBytes(projectStats)
  assert.equal(projectLogical, goldenLogical, 'Project VM clone logical size must match the Golden Disk')
  assert.ok(projectAllocated < projectLogical * 0.9, 'Project VM clone must remain thin after first boot')
  if (projectVhd) {
    assert.equal(projectVhd.VhdType, 'Differencing', 'Hyper-V Project VM must remain a differencing VHDX')
    assert.equal(resolve(projectVhd.ParentPath || '').toLowerCase(), resolve(disk).toLowerCase(), 'Hyper-V Project VM must retain the immutable Golden parent')
  }
  assert.ok(
    projectAllocated <= goldenAllocated + Math.max(2 * 1024 * 1024 * 1024, Math.ceil(goldenAllocated * 0.25)),
    `Project VM first boot allocation grew unexpectedly (${projectAllocated}/${goldenAllocated})`,
  )
  process.stdout.write(`[validate] thin disk verified: logical=${projectLogical} allocated=${projectAllocated} goldenAllocated=${goldenAllocated}\n`)
  process.stdout.write(`[validate] waiting for SSH...\n`)
  await waitSsh()
  process.stdout.write(`[validate] SSH reachable, blocking registry domains\n`)

  // Registry domains are made unresolvable inside this throwaway clone before
  // the runtime starts. The controller itself contains no pull path, but this
  // proves the complete first boot does not rely on registry egress.
  await machineCommand('sudo', ['-n', 'sh', '-c', 'for host in docker.io registry-1.docker.io auth.docker.io quay.io ghcr.io; do grep -q " $host$" /etc/hosts || printf "0.0.0.0 %s\\n" "$host" >> /etc/hosts; done'])
  const bootMount = await machineCommand('findmnt', ['-n', '-o', 'SOURCE,TARGET', '/boot'])
  assert.match(bootMount.stdout, /\s\/boot\s*$/, 'Project VM must boot with a dedicated /boot filesystem')
  const bootLabel = await machineCommand('blkid', ['-L', 'boot'])
  assert.match(bootLabel.stdout.trim(), /^\/dev\//, 'Project VM boot filesystem must be labelled boot')
  process.stdout.write(`[validate] verifying ${lock.services.length} pre-loaded image IDs\n`)
  for (const service of lock.services) {
    const result = await machineCommand('sudo', ['-n', 'podman', 'image', 'inspect', '--format', '{{.Id}}', service.image])
    const artifact = imageArtifacts.images.find((candidate) => candidate.service === service.name)
    assert.equal(artifact?.platformDigest, service.platforms[manifest.diskProjectSupabase.architecture].digest, `${service.name} platform manifest does not match lock`)
    const observedImageId = result.stdout.trim().replace(/^([a-f0-9]{64})$/, 'sha256:$1')
    assert.equal(observedImageId, artifact?.imageId, `${service.name} local image config ID does not match artifact`)
  }
  process.stdout.write(`[validate] all ${lock.services.length} image IDs verified ✓\n`)
  // Copy the working-tree runtime controller and bundle verifier into the VM
  // so the validation always exercises the latest code, even if the OCI image
  // was built from an earlier revision.  The composefs root is read-only, so
  // the updated files are placed under /var/lib/openlink (writable ostree var).
  await machineDriver.copyToMachine(machine, resolve(root, 'services/agent-host/project-supabase-runtime.mjs'), '/tmp/project-supabase-runtime.mjs')
  await machineDriver.copyToMachine(machine, resolve(root, 'scripts/lib/project-supabase-bundle.mjs'), '/tmp/project-supabase-bundle.mjs')
  await machineCommand('sudo', ['-n', 'sh', '-c', 'mkdir -p /var/lib/openlink && cp /tmp/project-supabase-runtime.mjs /var/lib/openlink/project-supabase-runtime && cp /tmp/project-supabase-bundle.mjs /var/lib/openlink/project-supabase-bundle.mjs && chmod 0755 /var/lib/openlink/project-supabase-runtime'])
  process.stdout.write(`[validate] project-supabase-runtime ensure (starting 11 containers)\n`)
  const ensure = await machineCommand('sudo', ['-n', '/var/lib/openlink/project-supabase-runtime', 'ensure', '--project-id', projectId, '--workspace', '/var/lib/openlink/workspace', '--gateway-port', String(gatewayPort), '--database-port', String(databasePort), '--pooler-port', String(poolerPort)])
  const publicConfig = JSON.parse(ensure.stdout)
  assert.equal(publicConfig.projectId, projectId)
  assert.equal(publicConfig.revision, lock.release.tag)
  assert.match(publicConfig.publishableKey, /^sb_publishable_/)

  process.stdout.write(`[validate] verifying all ${lock.services.length} containers are running\n`)
  const inspection = await machineCommand('sudo', ['-n', 'podman', 'ps', '--filter', 'label=io.openlink.project-supabase=true', '--format', 'json'])
  const containers = JSON.parse(inspection.stdout)
  assert.equal(containers.length, lock.services.length)
  for (const service of lock.services) {
    const container = containers.find((candidate) => candidate.Names?.includes(`openlink-project-supabase-${service.name}`))
    assert.ok(container, `${service.name} container is missing`)
    assert.equal(container.State, 'running', `${service.name} is not running`)
  }
  let secrets = JSON.parse((await machineResult('sudo', ['-n', 'cat', '/var/lib/openlink/project-supabase/secrets.json'])).stdout)
  // Copy e2e script into the VM and install the postgres npm package so the
  // test can run inside the VM.  Running inside the VM lets the e2e script
  // resolve the `db` container hostname directly, bypassing the Supavisor
  // pooler (which requires tenant registration that is not yet implemented
  // in the runtime manager).
  await machineDriver.copyToMachine(machine, resolve(root, 'scripts/e2e-project-supabase.mjs'), '/tmp/e2e-project-supabase.mjs')
  await machineCommand('sudo', ['-n', 'cp', '/tmp/e2e-project-supabase.mjs', '/var/lib/openlink/e2e-project-supabase.mjs'])
  await machineDriver.copyToMachine(machine, resolve(root, 'scripts/verify-project-supabase-persistence.mjs'), '/tmp/verify-project-supabase-persistence.mjs')
  await machineCommand('sudo', ['-n', 'cp', '/tmp/verify-project-supabase-persistence.mjs', '/var/lib/openlink/verify-project-supabase-persistence.mjs'])
  // Copy the postgres npm package from the host into the VM to avoid
  // depending on network access (the VM has Docker registries blocked and
  // npm registry may be unreachable).  pnpm stores the real files under
  // .pnpm; -h dereferences the symlink so tar archives the actual source.
  const postgresPkgTar = resolve(outputRoot, 'postgres-pkg.tar')
  await run('tar', ['-chf', postgresPkgTar, '-C', resolve(root, 'node_modules'), 'postgres'], { cwd: root })
  await machineDriver.copyToMachine(machine, postgresPkgTar, '/tmp/postgres-pkg.tar')
  await machineCommand('sudo', ['-n', 'sh', '-c', 'mkdir -p /var/lib/openlink/node_modules && tar -xf /tmp/postgres-pkg.tar -C /var/lib/openlink/node_modules'])
  async function runE2eInVm({ keepFixtures = false } = {}) {
    const dbIp = (await machineCommand('sudo', ['-n', 'podman', 'inspect', '--format', '{{(index .NetworkSettings.Networks "openlink-project-supabase").IPAddress}}', 'openlink-project-supabase-db'])).stdout.trim()
    const rtIp = (await machineCommand('sudo', ['-n', 'podman', 'inspect', '--format', '{{(index .NetworkSettings.Networks "openlink-project-supabase").IPAddress}}', 'openlink-project-supabase-realtime'])).stdout.trim()
    const e2eEnvironment = [
      `OPENLINK_PROJECT_SUPABASE_URL=http://127.0.0.1:${gatewayPort}`,
      `OPENLINK_PROJECT_SUPABASE_ANON_KEY=${secrets.ANON_KEY}`,
      `OPENLINK_PROJECT_SUPABASE_SERVICE_KEY=${secrets.SERVICE_ROLE_KEY}`,
      `OPENLINK_PROJECT_SUPABASE_DATABASE_URL=postgres://postgres:${encodeURIComponent(secrets.POSTGRES_PASSWORD)}@${dbIp}:5432/postgres`,
      `OPENLINK_PROJECT_SUPABASE_DASHBOARD_PASSWORD=${secrets.DASHBOARD_PASSWORD}`,
      `OPENLINK_PROJECT_SUPABASE_REALTIME_URL=http://${rtIp}:4000`,
      ...(keepFixtures ? ['OPENLINK_PROJECT_SUPABASE_KEEP_FIXTURES=1'] : []),
    ]
    return machineCommand('sudo', ['-n', 'env', ...e2eEnvironment, 'node', '/var/lib/openlink/e2e-project-supabase.mjs'])
  }
  async function verifyPersistenceInVm(marker) {
    const dbIp = (await machineCommand('sudo', ['-n', 'podman', 'inspect', '--format', '{{(index .NetworkSettings.Networks "openlink-project-supabase").IPAddress}}', 'openlink-project-supabase-db'])).stdout.trim()
    return machineCommand('sudo', [
      '-n', 'env',
      `OPENLINK_PROJECT_SUPABASE_URL=http://127.0.0.1:${gatewayPort}`,
      `OPENLINK_PROJECT_SUPABASE_SERVICE_KEY=${secrets.SERVICE_ROLE_KEY}`,
      `OPENLINK_PROJECT_SUPABASE_DATABASE_URL=postgres://postgres:${encodeURIComponent(secrets.POSTGRES_PASSWORD)}@${dbIp}:5432/postgres`,
      `OPENLINK_PROJECT_SUPABASE_PERSISTENCE_MARKER=${marker}`,
      'node', '/var/lib/openlink/verify-project-supabase-persistence.mjs',
    ])
  }
  process.stdout.write(`[validate] all containers running ✓, running e2e smoke test\n`)
  const e2e = await runE2eInVm({ keepFixtures: true })
  const smoke = JSON.parse(e2e.stdout.trim().split('\n').pop())
  assert.equal(smoke.ok, true)

  const bootIdBefore = (await machineCommand('cat', ['/proc/sys/kernel/random/boot_id'])).stdout.trim()
  assert.match(bootIdBefore, /^[0-9a-f-]{36}$/i)
  const diskBeforePowerCycle = await stat(machineDisk)
  process.stdout.write(`[validate] e2e smoke passed ✓, power-cycling the same registered VM for persistence test (boot ${bootIdBefore})\n`)
  await machineDriver.stopMachine(machine)
  await machineDriver.ensureMachine(machine, machineSpec)
  const bootIdAfter = await waitForGuestBootChange(bootIdBefore)
  const diskAfterPowerCycle = await stat(machineDisk)
  assert.equal(diskAfterPowerCycle.dev, diskBeforePowerCycle.dev)
  assert.equal(diskAfterPowerCycle.ino, diskBeforePowerCycle.ino, 'Project VM power cycle must retain the same disk file')
  process.stdout.write(`[validate] SSH reachable after Project VM power cycle (boot ${bootIdAfter}), re-ensuring runtime\n`)
  await machineCommand('sudo', ['-n', '/var/lib/openlink/project-supabase-runtime', 'ensure', '--project-id', projectId, '--workspace', '/var/lib/openlink/workspace', '--gateway-port', String(gatewayPort), '--database-port', String(databasePort), '--pooler-port', String(poolerPort)])
  process.stdout.write(`[validate] runtime re-ensured, verifying persisted Postgres and Storage fixtures\n`)
  const persisted = JSON.parse((await verifyPersistenceInVm(smoke.marker)).stdout.trim().split('\n').pop())
  assert.equal(persisted.ok, true)
  assert.equal(persisted.marker, smoke.marker)
  process.stdout.write(`[validate] persistence e2e passed ✓\n`)
  process.stdout.write(`${JSON.stringify({ ok: true, machine, projectId, release: lock.release.tag, images: lock.services.length, provider, disk: { logicalBytes: projectLogical, allocatedBytes: projectAllocated, goldenAllocatedBytes: goldenAllocated, mode: 'thin', retainedAcrossPowerCycle: true }, publicConfig, smoke, persistenceAfterVmRestart: true, guestBootIdChanged: true, bootIdBefore, bootIdAfter }, null, 2)}\n`)
} catch (error) {
  process.stdout.write(`[validate] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  throw error
} finally {
  process.stdout.write(`[validate] cleanup: removing validation VM ${created ? machine : '(not created)'}\n`)
  if (created && process.env.OPENLINK_PROJECT_SUPABASE_KEEP_VALIDATION_VM !== '1') await machineDriver.removeMachine(machine).catch(() => undefined)
}
