#!/usr/bin/env node
// One-command T1 <-> E1 project computer switch with data migration.
//
// The command is a maintenance operation: it quiesces the source VM, exports
// the workspace and Project Supabase state, archives the source runtime
// descriptor, provisions the target architecture, imports the data and
// health-checks the result. The source VM disk is retained so a failed switch
// can roll back and the operation can be repeated without data loss.
import { readFile, mkdir, rename, rm, writeFile, copyFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PodmanProjectRuntimeServiceDriver, ProjectRuntimeManager } from '../services/agent-host/dist/src/project-runtime.js'
import { PodmanMachineDriver, ProjectVmManager } from '../services/agent-host/dist/src/project-vm.js'
import { UbuntuQemuProjectVmDriver } from '../services/agent-host/dist/src/project-vm-ubuntu.js'
import {
  exportProjectComputerData,
  importProjectComputerData,
  projectArchitectureBackend,
  quiesceProjectContainers,
  readProjectMigrationManifest,
} from '../services/agent-host/dist/src/project-migration.js'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const args = process.argv.slice(2)
const stateRoot = resolve(process.env.OPENLINK_PROJECT_VM_STATE_ROOT || resolve(root, '.openlink-runtime/project-vms'))
const migrationRoot = resolve(process.env.OPENLINK_PROJECT_MIGRATION_ROOT || resolve(root, '.openlink-runtime/project-migrations'))
const projectId = option('--project') || option('--project-id')
const target = (option('--to') || '').trim().toLowerCase()
const dryRun = args.includes('--dry-run')
const allowRunningApp = args.includes('--allow-running-app')
const rootful = process.env.OPENLINK_PROJECT_VM_ROOTFUL !== '0'
const architectureBackends = new Map([['t1', 'qemu-kvm'], ['e1', 'podman-machine']])

function option(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function fail(message) {
  throw new Error(`OpenLink project switch: ${message}`)
}

async function bootId() {
  try { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() } catch { return undefined }
}

async function acquireMigrationLock(projectId) {
  const projectRoot = resolve(stateRoot, 'projects', projectId)
  await mkdir(projectRoot, { recursive: true, mode: 0o700 })
  const lockRoot = resolve(projectRoot, '.migration.lock')
  const currentBoot = await bootId()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await mkdir(lockRoot, { mode: 0o700 })
      await writeFile(resolve(lockRoot, 'owner.json'), `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        bootId: currentBoot,
        startedAt: new Date().toISOString(),
      })}\n`, { mode: 0o600 })
      return async () => {
        try {
          const owner = JSON.parse(await readFile(resolve(lockRoot, 'owner.json'), 'utf8'))
          if (owner.pid === process.pid) await rm(lockRoot, { recursive: true, force: true })
        } catch {}
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(resolve(lockRoot, 'owner.json'), 'utf8')) } catch {}
      const staleBoot = Boolean(owner && currentBoot && owner.bootId !== currentBoot)
      let alive = false
      if (!staleBoot && Number.isSafeInteger(owner?.pid)) {
        try { process.kill(owner.pid, 0); alive = true } catch (probeError) { alive = probeError?.code === 'EPERM' }
      }
      if (alive) fail(`another switch is already running for ${projectId} (pid ${owner.pid})`)
      await rm(lockRoot, { recursive: true, force: true })
    }
  }
  fail('could not acquire the project migration lock')
}

async function assertAppStopped() {
  if (allowRunningApp) return
  const url = process.env.OPENLINK_AGENT_HOST_URL || 'http://127.0.0.1:43121'
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(800) })
    if (response.ok) fail('the OpenLink app is running; stop it before a switch (or pass --allow-running-app for maintenance automation)')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('OpenLink project switch:')) throw error
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function requireFile(path, label) {
  const metadata = await stat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.size <= 0) fail(`${label} is missing: ${path}`)
  return metadata
}

function imageArchives() {
  const configured = process.env.OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES?.trim()
  if (configured) return JSON.parse(configured)
  const imageRoot = resolve(process.env.OPENLINK_RUNTIME_IMAGE_ROOT || resolve(homedir(), '.cache/openlink/project-images'))
  return {
    'openlink/agent-worker:dev': resolve(imageRoot, 'openlink_agent-worker_dev.tar'),
    'openlink/agent-rpc-worker:dev': resolve(imageRoot, 'openlink_agent-rpc-worker_dev.tar'),
    'openlink/browser-host:dev': resolve(imageRoot, 'openlink_browser-host_dev.tar'),
    'openlink/code-server:dev': resolve(imageRoot, 'openlink_code-server_dev.tar'),
    'openlink/opensandbox-server:dev': resolve(imageRoot, 'openlink_opensandbox-server_dev.tar'),
    'openlink/opensandbox-execd:dev': resolve(imageRoot, 'openlink_opensandbox-execd_dev.tar'),
    'openlink/opensandbox-egress:dev': resolve(imageRoot, 'openlink_opensandbox-egress_dev.tar'),
  }
}

function commonManagerOptions(vmManager, machineDriver, serviceDriver, projectDesktop) {
  return {
    stateRoot,
    vmManager,
    machineDriver,
    serviceDriver,
    opensandboxImage: 'openlink/opensandbox-server:dev',
    browserHostImage: 'openlink/browser-host:dev',
    execdImage: 'openlink/opensandbox-execd:dev',
    egressImage: 'openlink/opensandbox-egress:dev',
    agentWorkerImage: 'openlink/agent-worker:dev',
    agentRpcWorkerImage: 'openlink/agent-rpc-worker:dev',
    codeServerImage: 'openlink/code-server:dev',
    imageArchives: imageArchives(),
    projectPortBase: Number(process.env.OPENLINK_PROJECT_RUNTIME_PORT_BASE || 51_000),
    projectPortRangeSize: Number(process.env.OPENLINK_PROJECT_RUNTIME_PORT_RANGE_SIZE || 1_000),
    desktopPortOffset: Number(process.env.OPENLINK_PROJECT_RUNTIME_DESKTOP_PORT_OFFSET || 6_000),
    projectDesktop,
    browserAllowedOrigins: process.env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000',
    reattachProbeTimeoutMs: 20_000,
  }
}

async function createT1Runtime() {
  const baseRoot = resolve(process.env.OPENLINK_UBUNTU_PROJECT_VM_OUTPUT || resolve(root, '.openlink-runtime/project-vm-base/ubuntu'))
  const manifest = await readJson(resolve(baseRoot, 'manifest.json'))
  for (const key of ['disk', 'kernel', 'initrd', 'rootDevice', 'baseFingerprint']) {
    if (!manifest[key]) fail(`T1 manifest is missing ${key}`)
  }
  const diskPath = resolve(baseRoot, manifest.disk)
  const kernelPath = resolve(baseRoot, manifest.kernel.file)
  const initrdPath = resolve(baseRoot, manifest.initrd.file)
  await Promise.all([requireFile(diskPath, 'T1 base disk'), requireFile(kernelPath, 'T1 kernel'), requireFile(initrdPath, 'T1 initrd')])
  const seed = resolve(process.env.OPENLINK_PROJECT_SUPABASE_SEED || resolve(root, '.openlink-runtime/project-supabase/cache/seed.json'))
  await requireFile(seed, 'Project Supabase seed')
  const machineDriver = new UbuntuQemuProjectVmDriver({
    projectBaseDisk: diskPath,
    kernelPath,
    initrdPath,
    rootDevice: manifest.rootDevice,
    baseFingerprint: manifest.baseFingerprint,
    stateRoot,
    qemuCommand: process.env.OPENLINK_QEMU_SYSTEM_COMMAND || '/usr/bin/qemu-system-x86_64',
    qemuImgCommand: process.env.OPENLINK_QEMU_IMG_COMMAND || '/usr/bin/qemu-img',
    sshCommand: process.env.OPENLINK_SSH_COMMAND || '/usr/bin/ssh',
    scpCommand: process.env.OPENLINK_SCP_COMMAND || '/usr/bin/scp',
    sshKeygenCommand: process.env.OPENLINK_SSH_KEYGEN_COMMAND || '/usr/bin/ssh-keygen',
    mke2fsCommand: process.env.OPENLINK_MKE2FS_COMMAND || '/usr/sbin/mke2fs',
    guestUser: 'openlink',
    bootstrap: true,
  })
  const vmManager = new ProjectVmManager({
    stateRoot,
    machineDriver,
    backend: 'qemu-kvm',
    guestWorkspaceRoot: '/home/openlink/openlink/projects',
    machineSpec: { cpus: Number(process.env.OPENLINK_PROJECT_VM_CPUS || 4), memoryMb: Number(process.env.OPENLINK_PROJECT_VM_MEMORY_MB || 12_288), diskGb: Number(process.env.OPENLINK_PROJECT_VM_DISK_GB || 64), diskMode: 'thin' },
  })
  const serviceDriver = new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: true, publishAddress: '0.0.0.0' })
  const manager = new ProjectRuntimeManager({
    ...commonManagerOptions(vmManager, machineDriver, serviceDriver, true),
    projectSupabaseSeed: seed,
  })
  return { architecture: 't1', backend: 'qemu-kvm', machineDriver, vmManager, serviceDriver, manager }
}

async function createE1Runtime() {
  process.env.XDG_CONFIG_HOME ||= resolve(root, '.openlink-runtime/podman-config')
  process.env.XDG_DATA_HOME ||= resolve(root, '.openlink-runtime/podman-data')
  process.env.CONTAINERS_HELPER_BINARY_DIR ||= resolve(root, '.openlink-runtime/toolchain/bin')
  process.env.PATH = `${resolve(root, '.openlink-runtime/toolchain/bin')}:${process.env.PATH || ''}`
  const baseRoot = resolve(root, '.openlink-runtime/project-vm-base')
  const manifest = await readJson(resolve(baseRoot, 'manifest.json'))
  if (!manifest.disk) fail('E1 manifest is missing disk')
  const diskPath = resolve(baseRoot, manifest.disk)
  await requireFile(diskPath, 'E1 base disk')
  const machineDriver = new PodmanMachineDriver({
    command: process.env.OPENLINK_PODMAN_COMMAND || resolve(root, '.openlink-runtime/toolchain/bin/podman'),
    bootstrap: true,
    rootfulPodman: true,
    projectBaseDisk: diskPath,
    machineProvider: process.env.OPENLINK_PODMAN_MACHINE_PROVIDER || 'qemu',
    directAppleHv: process.platform === 'darwin',
    helperBinaryDirectory: process.env.CONTAINERS_HELPER_BINARY_DIR || resolve(root, '.openlink-runtime/toolchain/bin'),
  })
  const vmManager = new ProjectVmManager({
    stateRoot,
    machineDriver,
    guestWorkspaceRoot: '/home/core/openlink/projects',
    machineSpec: { cpus: Number(process.env.OPENLINK_PROJECT_VM_CPUS || 4), memoryMb: Number(process.env.OPENLINK_PROJECT_VM_MEMORY_MB || 8_192), diskGb: Number(process.env.OPENLINK_PROJECT_VM_DISK_GB || 64), diskMode: 'thin' },
  })
  const serviceDriver = new PodmanProjectRuntimeServiceDriver(machineDriver, { rootful: true, publishAddress: '0.0.0.0' })
  const manager = new ProjectRuntimeManager(commonManagerOptions(vmManager, machineDriver, serviceDriver, false))
  return { architecture: 'e1', backend: 'podman-machine', machineDriver, vmManager, serviceDriver, manager }
}

function createRuntime(architecture) {
  return architecture === 't1' ? createT1Runtime() : createE1Runtime()
}

function architectureForBackend(backend) {
  for (const [architecture, value] of architectureBackends) if (value === backend) return architecture
  fail(`unsupported source backend ${backend}`)
}

async function archiveRuntimeState(backend, backupDirectory) {
  const projectRoot = resolve(stateRoot, 'projects', projectId)
  const archiveRoot = resolve(projectRoot, 'architectures', backend)
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
  const runtimeBackup = resolve(backupDirectory, 'runtime')
  await mkdir(runtimeBackup, { recursive: true, mode: 0o700 })
  for (const name of ['runtime.json', 'ports.json', 'runtime-secrets.json']) {
    const source = resolve(projectRoot, name)
    try {
      await copyFile(source, resolve(runtimeBackup, name))
      await rename(source, resolve(archiveRoot, name))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

async function restoreArchivedRuntime(backend, backupDirectory) {
  const projectRoot = resolve(stateRoot, 'projects', projectId)
  const archiveRoot = resolve(projectRoot, 'architectures', backend)
  const runtimeBackup = resolve(backupDirectory, 'runtime')
  for (const name of ['runtime.json', 'ports.json', 'runtime-secrets.json']) {
    const archived = resolve(archiveRoot, name)
    const backup = resolve(runtimeBackup, name)
    const targetPath = resolve(projectRoot, name)
    try {
      await copyFile(archived, targetPath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        try { await copyFile(backup, targetPath) } catch (backupError) { if (backupError?.code !== 'ENOENT') throw backupError }
      } else throw error
    }
  }
}

async function clearTargetRuntimeState() {
  const projectRoot = resolve(stateRoot, 'projects', projectId)
  for (const name of ['runtime.json', 'ports.json', 'runtime-secrets.json']) {
    await rm(resolve(projectRoot, name), { force: true })
  }
}

async function verifyRuntime(runtime, descriptor) {
  const checks = [
    ['OpenSandbox', `${descriptor.opensandboxEndpoint}/health`, [200]],
    ['Browser Host', `${descriptor.browserHostEndpoint}/healthz`, [200, 204, 401, 403]],
    ['code-server', `${descriptor.codeServerEndpoint}/healthz`, [200, 204, 301, 302]],
  ]
  if (runtime.architecture === 't1') {
    if (!descriptor.desktopEndpoint) fail('T1 runtime did not publish a project desktop endpoint')
    checks.push(['desktop', `${descriptor.desktopEndpoint}/vnc.html`, [200]])
  } else if (descriptor.desktopEndpoint) {
    fail('E1 runtime unexpectedly published a project desktop endpoint')
  }
  for (const [label, url, expected] of checks) {
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      fail(`${label} health check failed (${url}): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!expected.includes(response.status)) fail(`${label} health check returned HTTP ${response.status} (${url})`)
  }
}

async function main() {
  if (!projectId || !/^[a-f0-9-]{36}$/i.test(projectId)) fail('--project must be a project UUID')
  if (!architectureBackends.has(target)) fail('--to must be t1 or e1')
  await assertAppStopped()
  const projectRoot = resolve(stateRoot, 'projects', projectId)
  const runtimePath = resolve(projectRoot, 'runtime.json')
  let sourceDescriptor
  try {
    sourceDescriptor = await readJson(runtimePath)
  } catch {
    fail(`project ${projectId} has no runtime descriptor under ${runtimePath}; provision it before switching`)
  }
  if (sourceDescriptor.projectId !== projectId) fail('runtime descriptor projectId does not match --project')
  const sourceArchitecture = architectureForBackend(sourceDescriptor.backend)
  if (sourceArchitecture === target) fail(`project is already running ${target}`)

  const releaseLock = await acquireMigrationLock(projectId)
  let source
  let runtimeTarget
  let backupDirectory
  let sourceStopped = false
  let sourceQuiesced = false
  let sourceQuiesce
  let targetQuiesce
  let targetStarted = false
  try {
    source = await createRuntime(sourceArchitecture)
    runtimeTarget = await createRuntime(target)
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    backupDirectory = resolve(migrationRoot, projectId, timestamp)

    if (dryRun) {
      process.stdout.write(`${JSON.stringify({
        status: 'planned',
        projectId,
        from: sourceArchitecture,
        to: target,
        sourceBackend: sourceDescriptor.backend,
        targetBackend: projectArchitectureBackend(target),
        backupDirectory,
        machineName: source.vmManager.machineName(projectId),
        workspacePath: source.vmManager.workspacePath(projectId),
      }, null, 2)}\n`)
      return
    }
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })

    await source.manager.ensure(projectId)
    sourceQuiesce = await quiesceProjectContainers(source.machineDriver, source.vmManager.machineName(projectId), { rootful })
    sourceQuiesced = true
    const manifest = await exportProjectComputerData({
      projectId,
      sourceArchitecture,
      sourceBackend: sourceDescriptor.backend,
      machineDriver: source.machineDriver,
      machineName: source.vmManager.machineName(projectId),
      workspacePath: source.vmManager.workspacePath(projectId),
      guestUser: sourceArchitecture === 't1' ? 'openlink' : 'core',
      outputDirectory: backupDirectory,
      rootful,
    })
    await readProjectMigrationManifest(backupDirectory)
    const sourceVmRecord = sourceArchitecture === 't1'
      ? resolve(stateRoot, 'ubuntu-vms', source.vmManager.machineName(projectId), 'vm.json')
      : undefined
    if (sourceVmRecord) {
      await copyFile(sourceVmRecord, resolve(backupDirectory, 'vm.json')).catch(() => undefined)
    }

    await sourceQuiesce.restore()
    sourceQuiesce = undefined
    await source.manager.stop(projectId)
    sourceStopped = true
    await archiveRuntimeState(sourceDescriptor.backend, backupDirectory)
    await clearTargetRuntimeState()
    // Preserve the source runtime's OpenSandbox/Browser tokens. The Supabase
    // keys travel inside the guest state archive and are revalidated by the
    // target controller after import.
    await copyFile(resolve(backupDirectory, 'runtime', 'runtime-secrets.json'), resolve(projectRoot, 'runtime-secrets.json')).catch(() => undefined)

    const targetDescriptor = await runtimeTarget.manager.ensure(projectId, 'thin')
    targetStarted = true
    targetQuiesce = await quiesceProjectContainers(runtimeTarget.machineDriver, runtimeTarget.vmManager.machineName(projectId), { rootful })
    let imported
    try {
      imported = await importProjectComputerData({
        machineDriver: runtimeTarget.machineDriver,
        machineName: runtimeTarget.vmManager.machineName(projectId),
        workspacePath: runtimeTarget.vmManager.workspacePath(projectId),
        guestUser: target === 't1' ? 'openlink' : 'core',
        archiveDirectory: backupDirectory,
        rootful,
      })
    } finally {
      await targetQuiesce.restore()
      targetQuiesce = undefined
    }
    const descriptor = await runtimeTarget.manager.ensure(projectId)
    await verifyRuntime(runtimeTarget, descriptor)
    await writeFile(resolve(backupDirectory, 'migration.json'), `${JSON.stringify({
      schemaVersion: 1,
      status: 'completed',
      projectId,
      from: sourceArchitecture,
      to: target,
      completedAt: new Date().toISOString(),
      manifest,
      target: {
        backend: descriptor.backend,
        endpoints: {
          opensandbox: descriptor.opensandboxEndpoint,
          browser: descriptor.browserHostEndpoint,
          codeServer: descriptor.codeServerEndpoint,
          desktop: descriptor.desktopEndpoint ?? null,
        },
      },
      import: imported,
    }, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`${JSON.stringify({
      status: 'completed',
      projectId,
      from: sourceArchitecture,
      to: target,
      backupDirectory,
      endpoints: {
        opensandbox: descriptor.opensandboxEndpoint,
        browser: descriptor.browserHostEndpoint,
        codeServer: descriptor.codeServerEndpoint,
        desktop: descriptor.desktopEndpoint ?? null,
      },
    }, null, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await sourceQuiesce?.restore().catch(() => undefined)
    await targetQuiesce?.restore().catch(() => undefined)
    sourceQuiesce = undefined
    targetQuiesce = undefined
    let rollback = 'not-needed'
    if (sourceStopped) {
      try {
        if (targetStarted) await runtimeTarget?.manager.stop(projectId).catch(() => runtimeTarget?.vmManager.stop(projectId))
        await clearTargetRuntimeState()
        await restoreArchivedRuntime(sourceDescriptor.backend, backupDirectory)
        await source.manager.ensure(projectId)
        rollback = 'restored-source'
      } catch (rollbackError) {
        rollback = `failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      }
    } else if (sourceQuiesced) {
      try {
        await source.manager.ensure(projectId)
        rollback = 'source-resumed'
      } catch (resumeError) {
        rollback = `failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`
      }
    }
    if (backupDirectory) {
      await writeFile(resolve(backupDirectory, 'migration.json'), `${JSON.stringify({
        schemaVersion: 1,
        status: 'failed',
        projectId,
        from: sourceArchitecture,
        to: target,
        failedAt: new Date().toISOString(),
        error: message,
        rollback,
      }, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined)
    }
    fail(`${message} (rollback: ${rollback}; backup: ${backupDirectory || 'none'})`)
  } finally {
    await releaseLock()
    await Promise.allSettled([
      source?.manager.close({ stopRuntimes: false }),
      runtimeTarget?.manager.close({ stopRuntimes: false }),
    ])
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
