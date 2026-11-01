import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { dirname as posixDirname, basename as posixBasename, resolve as posixResolve } from 'node:path/posix'
import { AgentHostError } from './errors.js'
import type { ProjectVmCommandResult, ProjectVmMachineDriver } from './project-vm.js'

const SUPABASE_STATE_ROOT = '/var/lib/openlink/project-supabase'
const SUPABASE_ITEMS = ['data', 'configuration', 'secrets.json'] as const
const SHA256 = /^[a-f0-9]{64}$/i
const ARCHITECTURES = new Set(['t1', 'e1'])

export type ProjectComputerArchitecture = 't1' | 'e1'

export interface ProjectMigrationArchive {
  file: string
  bytes: number
  sha256: string
}

export interface ProjectMigrationManifest {
  schemaVersion: 1
  projectId: string
  sourceArchitecture: ProjectComputerArchitecture
  sourceBackend: string
  createdAt: string
  sourceMachineName: string
  sourceWorkspacePath: string
  sourceGuestUser: string
  workspace: ProjectMigrationArchive
  supabase: ProjectMigrationArchive | null
}

export interface ProjectMigrationExportOptions {
  projectId: string
  sourceArchitecture: ProjectComputerArchitecture
  sourceBackend: string
  machineDriver: ProjectVmMachineDriver
  machineName: string
  workspacePath: string
  guestUser: string
  outputDirectory: string
  rootful?: boolean
}

export interface ProjectMigrationImportOptions {
  machineDriver: ProjectVmMachineDriver
  machineName: string
  workspacePath: string
  guestUser: string
  archiveDirectory: string
  rootful?: boolean
}

export interface ProjectMigrationImportResult {
  manifest: ProjectMigrationManifest
  workspaceBackupPath: string | null
  supabaseBackupPath: string | null
}

function fail(message: string): never {
  throw new AgentHostError('PROVISIONING_FAILED', `Project migration: ${message}`, { retryable: false })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function safeBasename(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    fail(`${label} is not a safe path component`)
  }
  return value
}

function requireEmptyOrSafeRelative(value: string, label: string): void {
  if (value.startsWith('/') || value.includes('\0')) fail(`${label} must be relative`)
  for (const component of value.split('/')) {
    if (component === '..') fail(`${label} must not contain '..'`)
  }
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectHash)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function hostArchive(path: string): Promise<ProjectMigrationArchive> {
  const metadata = await stat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.size <= 0) fail(`archive is missing or empty: ${path}`)
  return { file: basename(path), bytes: metadata.size, sha256: await hashFile(path) }
}

async function run(driver: ProjectVmMachineDriver, machine: string, command: string, args: string[]): Promise<ProjectVmCommandResult> {
  if (!driver.runInMachine) fail('driver cannot execute guest commands')
  return driver.runInMachine(machine, command, args)
}

async function guestFileArchive(driver: ProjectVmMachineDriver, machine: string, path: string): Promise<{ bytes: number; sha256: string }> {
  const result = await run(driver, machine, 'sudo', ['-n', 'sha256sum', path])
  const match = result.stdout.trim().match(/^([a-f0-9]{64})\s+/i)
  if (!match) fail(`guest checksum is invalid for ${path}`)
  const size = await run(driver, machine, 'sudo', ['-n', 'stat', '-c', '%s', path])
  const bytes = Number(size.stdout.trim())
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail(`guest size is invalid for ${path}`)
  return { bytes, sha256: match[1]!.toLowerCase() }
}

async function listTarEntries(driver: ProjectVmMachineDriver, machine: string, archive: string): Promise<string[]> {
  const result = await run(driver, machine, 'sudo', ['-n', 'tar', '-tf', archive])
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

function assertTarEntries(entries: string[], allowedTopLevel: Set<string>, label: string): void {
  if (entries.length === 0) fail(`${label} archive is empty`)
  for (const entry of entries) {
    requireEmptyOrSafeRelative(entry, `${label} archive entry`)
    const top = entry.split('/')[0]!
    if (!allowedTopLevel.has(top)) fail(`${label} archive contains an unexpected top-level path: ${top}`)
  }
}

export interface ProjectQuiesceResult {
  /** Restore the original restart policies without starting containers. */
  restore(): Promise<void>
}

export async function quiesceProjectContainers(
  driver: ProjectVmMachineDriver,
  machineName: string,
  options: { rootful?: boolean; timeoutMs?: number } = {},
): Promise<ProjectQuiesceResult> {
  const rootful = options.rootful ?? true
  const podman = (args: string[]) => rootful
    ? run(driver, machineName, 'sudo', ['-n', 'podman', ...args])
    : run(driver, machineName, 'podman', args)
  const ids = await podman(['ps', '--all', '--quiet']).then((result) => result.stdout.split(/\s+/).filter(Boolean)).catch(() => [])
  const policies = new Map<string, string>()
  if (ids.length) {
    const inspected = await podman(['inspect', '--format', '{{.Id}} {{.HostConfig.RestartPolicy.Name}}', ...ids])
    for (const line of inspected.stdout.split('\n')) {
      const match = line.trim().match(/^([a-f0-9]+)\s+(\S+)/i)
      if (match) policies.set(match[1]!.toLowerCase(), match[2]!)
    }
  }
  let policiesMutable = true
  for (const id of policies.keys()) {
    try {
      await podman(['update', '--restart=no', id])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/no such|not found|does not exist/i.test(message)) continue
      // Podman 4.x predates `podman update --restart`. In that case rely on
      // `podman stop` suppressing the restart policy and leave the policy
      // untouched; quiesce still verifies that every container exited.
      if (/unknown flag|unknown option|flag provided but not defined/i.test(message)) {
        policiesMutable = false
        break
      }
      throw error
    }
  }
  let stopFailure: unknown
  await podman(['stop', '--all']).catch((error) => { stopFailure = error })
  const benignStopFailure = stopFailure === undefined
    || /no containers|no such container|nothing to stop/i.test(stopFailure instanceof Error ? stopFailure.message : String(stopFailure))
  let forceKilled = false
  if (!benignStopFailure) {
    // Some Podman versions leave a container in "improper" state after a
    // timeout. Killing the cgroup is the last safe quiesce step before tarring
    // its data; the container remains durable and can be started again after
    // a rollback.
    await podman(['kill', '--all']).catch(() => undefined)
    forceKilled = true
  }
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  while (Date.now() < deadline) {
    const remaining = await podman(['ps', '--quiet']).catch(() => ({ stdout: '', stderr: '' }))
    if (!remaining.stdout.trim()) {
      return {
        restore: async () => {
          if (!policiesMutable) return
          for (const [id, policy] of policies) {
            if (policy === 'no' || policy === '') continue
            await podman(['update', `--restart=${policy}`, id]).catch(() => undefined)
          }
        },
      }
    }
    if (!forceKilled) {
      await podman(['kill', '--all']).catch(() => undefined)
      forceKilled = true
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  fail(`containers on ${machineName} did not stop within the quiesce window`)
}

export async function exportProjectComputerData(options: ProjectMigrationExportOptions): Promise<ProjectMigrationManifest> {
  const driver = options.machineDriver
  if (!driver.copyFromMachine) fail('driver cannot copy migration archives out of the guest')
  if (!isAbsolute(options.workspacePath)) fail('workspace path must be absolute')
  const workspaceParent = posixDirname(options.workspacePath)
  const workspaceName = safeBasename(posixBasename(options.workspacePath), 'workspace basename')
  const guestStage = `/var/tmp/openlink-migration-${randomUUID()}`
  const hostDirectory = resolve(options.outputDirectory)
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
  const rootful = options.rootful ?? true
  let workspaceArchive: ProjectMigrationArchive | null = null
  let supabaseArchive: ProjectMigrationArchive | null = null
  try {
    await run(driver, options.machineName, 'sudo', ['-n', 'mkdir', '-p', guestStage])
    await run(driver, options.machineName, 'sudo', ['-n', 'chmod', '0700', guestStage])
    const workspaceExists = await run(driver, options.machineName, 'sudo', ['-n', 'test', '-d', options.workspacePath])
      .then(() => true).catch(() => false)
    if (!workspaceExists) fail(`workspace does not exist in the guest: ${options.workspacePath}`)
    await run(driver, options.machineName, 'sudo', [
      '-n', 'tar', '--numeric-owner', '-C', workspaceParent, '-cf', `${guestStage}/workspace.tar`, workspaceName,
    ])
    await run(driver, options.machineName, 'sudo', ['-n', 'sync', '-f', `${guestStage}/workspace.tar`])

    const supabaseExists = await run(driver, options.machineName, 'sudo', ['-n', 'test', '-d', `${SUPABASE_STATE_ROOT}/data`])
      .then(() => true).catch(() => false)
    if (supabaseExists) {
      await run(driver, options.machineName, 'sudo', [
        '-n', 'sh', '-c',
        `set -eu; cd ${shellQuote(SUPABASE_STATE_ROOT)}; items=''; for item in ${SUPABASE_ITEMS.map(shellQuote).join(' ')}; do [ -e "$item" ] && items="$items $item"; done; [ -n "$items" ] && tar --numeric-owner -cf ${shellQuote(`${guestStage}/supabase.tar`)} $items; sync -f ${shellQuote(`${guestStage}/supabase.tar`)}`,
      ])
    }

    const workspaceGuest = await guestFileArchive(driver, options.machineName, `${guestStage}/workspace.tar`)
    // copyFromMachine runs as the unprivileged guest user. The archives were
    // created by sudo in a 0700 directory, so publish them read-only for the
    // transfer; the staging directory is removed immediately afterwards.
    await run(driver, options.machineName, 'sudo', ['-n', 'chmod', '0755', guestStage])
    await run(driver, options.machineName, 'sudo', ['-n', 'chmod', '0644', `${guestStage}/workspace.tar`])
    if (supabaseExists) await run(driver, options.machineName, 'sudo', ['-n', 'chmod', '0644', `${guestStage}/supabase.tar`])
    const workspacePath = resolve(hostDirectory, 'workspace.tar')
    await driver.copyFromMachine(options.machineName, `${guestStage}/workspace.tar`, workspacePath)
    await chmod(workspacePath, 0o600)
    workspaceArchive = await hostArchive(workspacePath)
    if (workspaceArchive.bytes !== workspaceGuest.bytes || workspaceArchive.sha256 !== workspaceGuest.sha256) {
      fail('workspace archive changed during transfer')
    }

    if (supabaseExists) {
      const supabaseGuest = await guestFileArchive(driver, options.machineName, `${guestStage}/supabase.tar`)
      const supabasePath = resolve(hostDirectory, 'supabase.tar')
      await driver.copyFromMachine(options.machineName, `${guestStage}/supabase.tar`, supabasePath)
      await chmod(supabasePath, 0o600)
      supabaseArchive = await hostArchive(supabasePath)
      if (supabaseArchive.bytes !== supabaseGuest.bytes || supabaseArchive.sha256 !== supabaseGuest.sha256) {
        fail('Supabase archive changed during transfer')
      }
    }

    const manifest: ProjectMigrationManifest = {
      schemaVersion: 1,
      projectId: options.projectId,
      sourceArchitecture: options.sourceArchitecture,
      sourceBackend: options.sourceBackend,
      createdAt: new Date().toISOString(),
      sourceMachineName: options.machineName,
      sourceWorkspacePath: options.workspacePath,
      sourceGuestUser: options.guestUser,
      workspace: workspaceArchive,
      supabase: supabaseArchive,
    }
    await writeFile(resolve(hostDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    return manifest
  } finally {
    await run(driver, options.machineName, 'sudo', ['-n', 'rm', '-rf', guestStage]).catch(() => undefined)
  }
}

function validateManifest(value: unknown): ProjectMigrationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest is invalid')
  const manifest = value as Partial<ProjectMigrationManifest>
  if (manifest.schemaVersion !== 1) fail('manifest schemaVersion is unsupported')
  if (!/^[a-f0-9-]{36}$/i.test(manifest.projectId ?? '')) fail('manifest projectId is invalid')
  if (!ARCHITECTURES.has(manifest.sourceArchitecture ?? '')) fail('manifest sourceArchitecture is invalid')
  if (typeof manifest.sourceBackend !== 'string' || !manifest.sourceBackend) fail('manifest sourceBackend is invalid')
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) fail('manifest createdAt is invalid')
  for (const key of ['workspace', 'supabase'] as const) {
    const archive = manifest[key]
    if (key === 'supabase' && archive === null) continue
    if (!archive || typeof archive !== 'object') fail(`manifest ${key} is missing`)
    safeBasename(archive.file, `${key} archive name`)
    if (!Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) fail(`manifest ${key} size is invalid`)
    if (!SHA256.test(archive.sha256)) fail(`manifest ${key} checksum is invalid`)
  }
  return manifest as ProjectMigrationManifest
}

export async function readProjectMigrationManifest(directory: string): Promise<ProjectMigrationManifest> {
  const value = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'))
  const manifest = validateManifest(value)
  for (const archive of [manifest.workspace, manifest.supabase]) {
    if (!archive) continue
    const host = resolve(directory, archive.file)
    const actual = await hostArchive(host)
    if (actual.bytes !== archive.bytes || actual.sha256 !== archive.sha256) {
      fail(`archive checksum mismatch: ${archive.file}`)
    }
  }
  return manifest
}

async function moveAside(driver: ProjectVmMachineDriver, machine: string, source: string, destination: string): Promise<void> {
  const exists = await run(driver, machine, 'sudo', ['-n', 'test', '-e', source]).then(() => true).catch(() => false)
  if (!exists) return
  await run(driver, machine, 'sudo', ['-n', 'mkdir', '-p', destination])
  await run(driver, machine, 'sudo', ['-n', 'mv', source, `${destination}/${posixBasename(source)}`])
}

export async function importProjectComputerData(options: ProjectMigrationImportOptions): Promise<ProjectMigrationImportResult> {
  const driver = options.machineDriver
  if (!driver.copyToMachine) fail('driver cannot copy migration archives into the guest')
  if (!isAbsolute(options.workspacePath)) fail('workspace path must be absolute')
  const manifest = await readProjectMigrationManifest(options.archiveDirectory)
  const archiveDirectory = resolve(options.archiveDirectory)
  const workspaceParent = posixDirname(options.workspacePath)
  const workspaceName = safeBasename(posixBasename(options.workspacePath), 'workspace basename')
  const guestStage = `/var/tmp/openlink-migration-${randomUUID()}`
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const workspaceBackupPath = `${workspaceParent}/.${workspaceName}.migration-${timestamp}`
  const supabaseBackupPath = `${SUPABASE_STATE_ROOT}/.migration-previous-${timestamp}`
  const rootful = options.rootful ?? true
  try {
    // The guest login user owns the transfer staging directory. Archives are
    // copied by that user and later extracted as root; creating the directory
    // with sudo would make copyToMachine fail with a permission error.
    await run(driver, options.machineName, 'mkdir', ['-p', guestStage])
    await run(driver, options.machineName, 'chmod', ['0700', guestStage])
    await driver.copyToMachine(options.machineName, resolve(archiveDirectory, manifest.workspace.file), `${guestStage}/workspace.tar`)
    if (manifest.supabase) {
      await driver.copyToMachine(options.machineName, resolve(archiveDirectory, manifest.supabase.file), `${guestStage}/supabase.tar`)
    }
    const transferred: Array<[ProjectMigrationArchive, string]> = [[manifest.workspace, `${guestStage}/workspace.tar`]]
    if (manifest.supabase) transferred.push([manifest.supabase, `${guestStage}/supabase.tar`])
    for (const [archive, guestPath] of transferred) {
      const actual = await guestFileArchive(driver, options.machineName, guestPath)
      if (actual.bytes !== archive.bytes || actual.sha256 !== archive.sha256) fail(`transferred archive checksum mismatch: ${archive.file}`)
    }

    assertTarEntries(await listTarEntries(driver, options.machineName, `${guestStage}/workspace.tar`), new Set([workspaceName]), 'workspace')
    if (manifest.supabase) {
      assertTarEntries(
        await listTarEntries(driver, options.machineName, `${guestStage}/supabase.tar`),
        new Set(SUPABASE_ITEMS),
        'Supabase',
      )
    }

    // Replace the workspace atomically enough for recovery: move the current
    // tree aside first, extract into place, and restore it if extraction fails.
    await moveAside(driver, options.machineName, options.workspacePath, workspaceBackupPath)
    try {
      await run(driver, options.machineName, 'sudo', ['-n', 'mkdir', '-p', workspaceParent])
      await run(driver, options.machineName, 'sudo', ['-n', 'tar', '--numeric-owner', '-xpf', `${guestStage}/workspace.tar`, '-C', workspaceParent])
      await run(driver, options.machineName, 'sudo', ['-n', 'sync', '-f', options.workspacePath])
    } catch (error) {
      await run(driver, options.machineName, 'sudo', ['-n', 'rm', '-rf', options.workspacePath]).catch(() => undefined)
      await run(driver, options.machineName, 'sudo', ['-n', 'mv', `${workspaceBackupPath}/${workspaceName}`, options.workspacePath]).catch(() => undefined)
      throw error
    }

    if (manifest.supabase) {
      const current = await run(driver, options.machineName, 'sudo', ['-n', 'test', '-d', SUPABASE_STATE_ROOT]).then(() => true).catch(() => false)
      if (current) {
        for (const item of SUPABASE_ITEMS) {
          await moveAside(driver, options.machineName, posixResolve(SUPABASE_STATE_ROOT, item), supabaseBackupPath)
        }
      } else {
        await run(driver, options.machineName, 'sudo', ['-n', 'mkdir', '-p', SUPABASE_STATE_ROOT])
      }
      try {
        await run(driver, options.machineName, 'sudo', ['-n', 'tar', '--numeric-owner', '-xpf', `${guestStage}/supabase.tar`, '-C', SUPABASE_STATE_ROOT])
        await run(driver, options.machineName, 'sudo', ['-n', 'chmod', '0600', posixResolve(SUPABASE_STATE_ROOT, 'secrets.json')]).catch(() => undefined)
        await run(driver, options.machineName, 'sudo', ['-n', 'sync', '-f', SUPABASE_STATE_ROOT])
      } catch (error) {
        for (const item of SUPABASE_ITEMS) {
          await run(driver, options.machineName, 'sudo', ['-n', 'rm', '-rf', posixResolve(SUPABASE_STATE_ROOT, item)]).catch(() => undefined)
          await run(driver, options.machineName, 'sudo', ['-n', 'mv', `${supabaseBackupPath}/${item}`, posixResolve(SUPABASE_STATE_ROOT, item)]).catch(() => undefined)
        }
        throw error
      }
    }

    const workspaceBackup = await run(driver, options.machineName, 'sudo', ['-n', 'test', '-e', workspaceBackupPath])
      .then(() => true).catch(() => false)
    const supabaseBackup = await run(driver, options.machineName, 'sudo', ['-n', 'test', '-e', supabaseBackupPath])
      .then(() => true).catch(() => false)
    return {
      manifest,
      workspaceBackupPath: workspaceBackup ? workspaceBackupPath : null,
      supabaseBackupPath: supabaseBackup ? supabaseBackupPath : null,
    }
  } finally {
    await run(driver, options.machineName, 'sudo', ['-n', 'rm', '-rf', guestStage]).catch(() => undefined)
  }
}

export function projectArchitectureBackend(architecture: ProjectComputerArchitecture): string {
  return architecture === 't1' ? 'qemu-kvm' : 'podman-machine'
}
