import { execFile as execFileCallback, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, parse as parsePath, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.js'

const execFile = promisify(execFileCallback)

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HYPERV_START_RECONCILE_ATTEMPTS = 20
const HYPERV_START_RECONCILE_DELAY_MS = 500

export type ProjectVmDiskMode = 'thin' | 'thick'
export type PodmanMachineProvider = 'applehv' | 'hyperv' | 'qemu'

export interface ProjectVmMachineSpec {
  cpus: number
  memoryMb: number
  diskGb: number
  /** Host allocation policy; guest-visible capacity and capabilities match. */
  diskMode: ProjectVmDiskMode
  /** Host ports which the VM must forward to the project guest. */
  servicePorts?: number[]
  /** Host port used to reach the guest SSH server. */
  sshPort?: number
}

export interface ProjectVmDescriptor {
  projectId: string
  machineName: string
  workspacePath: string
  backend: ProjectVmBackend
  diskMode: ProjectVmDiskMode
  status: 'ready'
}

export interface ProjectVmCommandResult {
  stdout: string
  stderr: string
}

export type ProjectVmBackend = 'podman-machine' | 'qemu-kvm' | 'docker-container'

export interface ProjectVmPortForward {
  readonly localPort: number
  close(): Promise<void>
}

export type ProjectVmCommandRunner = (command: string, args: string[]) => Promise<ProjectVmCommandResult>

export interface ProjectVmMachineDriver {
  ensureMachine(name: string, spec: ProjectVmMachineSpec): Promise<void>
  bootstrapToolchain(name: string): Promise<void>
  runInMachine?(name: string, command: string, args?: string[]): Promise<ProjectVmCommandResult>
  copyToMachine?(name: string, sourcePath: string, destinationPath: string): Promise<void>
  /** Copy an artifact already present on the VM host into the guest. */
  copyRemoteToMachine?(name: string, sourcePath: string, destinationPath: string): Promise<void>
  /**
   * Forward a port exposed on the VM's host to the Agent Host process. Local
   * Podman machines already expose published ports and return no forwarder;
   * SSH-backed drivers return a real tunnel which must be closed with the
   * project runtime.
   */
  forwardPort?(name: string, remotePort: number): Promise<ProjectVmPortForward>
  stopMachine(name: string): Promise<void>
  removeMachine(name: string): Promise<void>
}

export interface PodmanMachineDriverOptions {
  command?: string
  run?: ProjectVmCommandRunner
  bootstrap?: boolean
  /** Use the VM's system Podman socket instead of the rootless user socket. */
  rootfulPodman?: boolean
  /** Bootable local disk image produced by the OpenLink image pipeline. */
  projectBaseDisk?: string
  /** APFS/reflink clone hook; injectable for deterministic tests. */
  cloneDisk?: (source: string, destination: string) => Promise<void>
  /** Full independent disk materialization hook; injectable for tests. */
  materializeDisk?: (source: string, destination: string) => Promise<void>
  /** Resolve the Podman-owned target disk when inspect omits ImagePath. */
  machineDiskPath?: (name: string) => string | undefined
  /** Explicit native provider selected by the root host lifecycle. */
  machineProvider?: PodmanMachineProvider
  /** Run AppleHV machines directly so multiple Project VMs can be active. */
  directAppleHv?: boolean
  /** Directory containing repository-bundled vfkit and gvproxy binaries. */
  helperBinaryDirectory?: string
  /**
   * Prepare the native Hyper-V networking helper before a machine starts.
   * Injectable so the Windows lifecycle can be tested without host mutation.
   */
  prepareHyperVNetworking?: (machineName: string) => Promise<void>
  /** Keep a partially created machine when an explicit diagnostic run asks for it. */
  preserveFailedMachine?: boolean
  /** Durable host process state for directly managed AppleHV machines. */
  directStateRoot?: string
  /** Short-lived Unix sockets; must stay below macOS's sockaddr_un limit. */
  directSocketRoot?: string
}

const PREPARE_HYPERV_NETWORKING_SCRIPT = String.raw`
& {
param(
  [Parameter(Mandatory = $true)][string]$helperRootArgument,
  [Parameter(Mandatory = $true)][string]$startingMachineArgument
)
$ErrorActionPreference = 'Stop'
$helperRoot = [IO.Path]::GetFullPath($helperRootArgument).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$expectedExecutable = [IO.Path]::Combine($helperRoot, 'gvproxy.exe')
$startingMachine = $startingMachineArgument
$machinePattern = [regex]'-forward-sock\s+npipe:////\./pipe/podman-([A-Za-z0-9_.-]+)(?:\s|$)'
$reaped = [Collections.Generic.List[object]]::new()
$conflicts = [Collections.Generic.List[object]]::new()

foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'gvproxy.exe'" -ErrorAction Stop)) {
  if (-not $candidate.ExecutablePath -or -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($candidate.ExecutablePath), $expectedExecutable)) { continue }
  $match = $machinePattern.Match([string]$candidate.CommandLine)
  if (-not $match.Success) { continue }
  $machineName = $match.Groups[1].Value
  $vm = Get-VM -Name $machineName -ErrorAction SilentlyContinue
  if ($vm -and $vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Running) {
    $conflicts.Add([ordered]@{ ProcessId = [int]$candidate.ProcessId; MachineName = $machineName })
    continue
  }

  # Re-read the process immediately before termination. This prevents a PID
  # reuse race from turning an orphan cleanup into an unrelated process kill.
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.ProcessId)" -ErrorAction SilentlyContinue
  if (-not $current -or -not $current.ExecutablePath -or -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($current.ExecutablePath), $expectedExecutable)) { continue }
  $currentMatch = $machinePattern.Match([string]$current.CommandLine)
  if (-not $currentMatch.Success -or $currentMatch.Groups[1].Value -ne $machineName) { continue }
  Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop
  $reaped.Add([ordered]@{ ProcessId = [int]$candidate.ProcessId; MachineName = $machineName })
}

if ($conflicts.Count -gt 0) {
  $names = ($conflicts | ForEach-Object MachineName | Sort-Object -Unique) -join ', '
  throw "OpenLink Hyper-V networking is already owned by running machine(s): $names; cannot start $startingMachine"
}

[ordered]@{ Reaped = @($reaped); Conflicts = @($conflicts) } | ConvertTo-Json -Compress -Depth 4
}
`.trim()

/**
 * Podman Hyper-V gvproxy binds a host-wide VSOCK service. An interrupted
 * machine removal can leave the product-owned helper alive after its VM has
 * gone, causing the next guest to connect to an old SSH identity. Reap only
 * helpers from the exact bundled directory whose referenced VM is not running.
 */
export async function prepareHyperVNetworking(
  helperBinaryDirectory: string,
  machineName: string,
  run: ProjectVmCommandRunner = runCommand,
): Promise<void> {
  await run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    PREPARE_HYPERV_NETWORKING_SCRIPT,
    resolve(helperBinaryDirectory),
    machineName,
  ])
}

interface CommandError extends Error {
  code?: string | number
  stderr?: string
  stdout?: string
}

interface AppleHvMachineConfig {
  Name: string
  LastUp?: string
  Resources: { CPUs: number; Memory: number }
  SSH: { IdentityPath: string; Port: number; RemoteUsername: string }
  ImagePath: { Path: string }
  AppleHypervisor: {
    Vfkit: {
      Endpoint: string
      VirtualMachine: { bootloader: { efiVariableStorePath: string } }
    }
  }
  Mounts?: Array<{
    Source: string
    Target: string
    Tag: string
    Type: 'virtiofs'
    ReadOnly?: boolean
  }>
}

export function appleHvMachineHasBooted(config: { LastUp?: string }): boolean {
  const value = config.LastUp?.trim()
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > Date.UTC(1970, 0, 1)
}

interface DirectAppleHvState {
  machineName: string
  vfkitPid: number
  gvproxyPid: number
  createdAt: string
}

async function runCommand(command: string, args: string[], timeout?: number): Promise<ProjectVmCommandResult> {
  try {
    const result = await execFile(command, args, {
      shell: false,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      ...(timeout === undefined ? {} : { timeout, killSignal: 'SIGTERM' as const }),
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as CommandError
    // `podman machine ssh` can put the guest-side command failure in stdout
    // while the host-side ssh wrapper only exposes a generic stderr message.
    // Preserve both streams so a provisioning failure contains the actual
    // guest error (for example a rejected bind mount or unsupported flag)
    // instead of only the opaque host command line.
    const detail = [failure.stderr?.trim(), failure.stdout?.trim(), failure.message]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join("; ")
    throw new AgentHostError(
      failure.code === 'ENOENT' ? 'BACKEND_NOT_CONFIGURED' : 'PROVISIONING_FAILED',
      `${command} ${args.join(' ')} failed: ${detail}`,
      { retryable: true },
    )
  }
}

function machineState(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = Array.isArray(parsed) ? parsed[0] : parsed
    if (!record || typeof record !== 'object') return undefined
    const value = (record as Record<string, unknown>).State
      ?? (record as Record<string, unknown>).state
    return typeof value === 'string' ? value.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function machineRootful(raw: string): boolean | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = Array.isArray(parsed) ? parsed[0] : parsed
    if (!record || typeof record !== 'object') return undefined
    const value = (record as Record<string, unknown>).Rootful
      ?? (record as Record<string, unknown>).rootful
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

function machineDiskPath(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    const record = Array.isArray(parsed) ? parsed[0] : parsed
    if (!record || typeof record !== 'object') return undefined
    const image = (record as Record<string, unknown>).ImagePath
      ?? (record as Record<string, unknown>).imagePath
    const value = typeof image === 'string'
      ? image
      : image && typeof image === 'object'
        ? (image as Record<string, unknown>).Path ?? (image as Record<string, unknown>).path
        : undefined
    return typeof value === 'string' && isAbsolute(value) ? value : undefined
  } catch {
    return undefined
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'"
}

// vfkit's compatibility networking path requires Podman's reserved AppleHV
// address. Each Project owns a separate gvproxy network, so reusing it across
// independent processes does not create a layer-2 collision.
const APPLEHV_MAC_ADDRESS = '5a:94:ef:e4:0c:ee'
const APPLEHV_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 60_000

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

async function availablePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('Unable to reserve a local port')))
        return
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port))
    })
  })
}

function processIsRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 2) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (processIsRunning(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

const THICK_DISK_SAFETY_BYTES = 2 * 1024 * 1024 * 1024
const DISK_COPY_BUFFER_BYTES = 16 * 1024 * 1024
const PODMAN_INIT_PLACEHOLDER_BYTES = 4_096
const PODMAN_EXPANDED_PLACEHOLDER_MAX_ALLOCATION_BYTES = 512 * 1024 * 1024
const THIN_DISK_MATERIALIZATION_RATIO = 0.9
const THIN_DISK_ALLOCATION_TOLERANCE_BYTES = 512 * 1024 * 1024

function diskAllocatedBytes(stats: { blocks: number }): number {
  const allocated = Number(stats.blocks) * 512
  if (!Number.isSafeInteger(allocated) || allocated < 0) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Host filesystem did not expose valid Project VM disk allocation metadata', { retryable: true })
  }
  return allocated
}

interface HyperVVhdInfo {
  Path: string
  VhdType: 'Dynamic' | 'Differencing' | 'Fixed'
  VhdFormat: 'VHDX'
  Size: number
  FileSize: number
  ParentPath?: string
  IsReadOnly: boolean
}

const INSPECT_VHD_SCRIPT = '& { param($Path); $vhd = Get-VHD -Path $Path -ErrorAction Stop; $file = Get-Item -LiteralPath $Path -Force -ErrorAction Stop; [pscustomobject]@{ Path = $vhd.Path; VhdType = $vhd.VhdType.ToString(); VhdFormat = $vhd.VhdFormat.ToString(); Size = [int64]$vhd.Size; FileSize = [int64]$vhd.FileSize; ParentPath = $vhd.ParentPath; IsReadOnly = [bool]$file.IsReadOnly } | ConvertTo-Json -Compress }'

const CREATE_DYNAMIC_VHD_SCRIPT = [
  '& { param($Path, $SizeBytes)',
  '$size = [int64]::Parse($SizeBytes, [Globalization.CultureInfo]::InvariantCulture)',
  'New-VHD -Path $Path -Dynamic -SizeBytes $size -BlockSizeBytes 2097152 -ErrorAction Stop | Out-Null }',
].join('; ')

const CREATE_DIFFERENCING_VHD_SCRIPT = '& { param($Path, $ParentPath); New-VHD -Path $Path -ParentPath $ParentPath -Differencing -ErrorAction Stop | Out-Null }'
const REPLACE_VHD_SCRIPT = '& { param($Staging, $Destination, $Backup); [IO.File]::Replace($Staging, $Destination, $Backup, $true) }'

export async function inspectHyperVVhd(path: string, runner: ProjectVmCommandRunner = runCommand): Promise<HyperVVhdInfo> {
  const result = await runner('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', INSPECT_VHD_SCRIPT, path])
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) } catch { throw new AgentHostError('PROVISIONING_FAILED', `Hyper-V returned invalid VHD metadata for ${path}`, { retryable: true }) }
  if (!parsed || typeof parsed !== 'object') throw new AgentHostError('PROVISIONING_FAILED', `Hyper-V returned empty VHD metadata for ${path}`, { retryable: true })
  const record = parsed as Record<string, unknown>
  if (record.VhdFormat !== 'VHDX'
    || !['Dynamic', 'Differencing', 'Fixed'].includes(String(record.VhdType))
    || !Number.isSafeInteger(record.Size) || Number(record.Size) <= 0
    || !Number.isSafeInteger(record.FileSize) || Number(record.FileSize) <= 0
    || typeof record.IsReadOnly !== 'boolean') {
    throw new AgentHostError('PROVISIONING_FAILED', `Hyper-V returned unsupported VHD metadata for ${path}`, { retryable: false })
  }
  return record as unknown as HyperVVhdInfo
}

async function createHyperVPlaceholder(path: string, logicalBytes: number, runner: ProjectVmCommandRunner): Promise<void> {
  await runner('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CREATE_DYNAMIC_VHD_SCRIPT,
    path, String(logicalBytes),
  ])
  const info = await inspectHyperVVhd(path, runner)
  if (info.VhdType !== 'Dynamic' || info.Size !== logicalBytes || info.FileSize > PODMAN_EXPANDED_PLACEHOLDER_MAX_ALLOCATION_BYTES) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Hyper-V did not create a protected dynamic Project VM placeholder', { retryable: true })
  }
}

export async function cloneThinHyperVProjectVmDisk(
  source: string,
  destination: string,
  runner: ProjectVmCommandRunner = runCommand,
): Promise<void> {
  const sourcePath = resolve(source)
  const destinationPath = resolve(destination)
  if (sourcePath === destinationPath) throw new AgentHostError('PROVISIONING_FAILED', 'Project VM Golden Disk and destination must be different files', { retryable: false })
  if (parsePath(sourcePath).root.toLowerCase() !== parsePath(destinationPath).root.toLowerCase()) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Hyper-V Golden and Project VHDX files must use the same host volume', { retryable: true })
  }
  const [sourceStats, destinationStats] = await Promise.all([lstat(sourcePath), lstat(destinationPath)]).catch((error) => {
    throw new AgentHostError('PROVISIONING_FAILED', `Hyper-V Project VM disk is unavailable: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
  })
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || !destinationStats.isFile() || destinationStats.isSymbolicLink()) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Hyper-V Project VM disks must be regular files', { retryable: false })
  }

  const [golden, placeholder] = await Promise.all([
    inspectHyperVVhd(sourcePath, runner),
    inspectHyperVVhd(destinationPath, runner),
  ])
  if (golden.VhdType !== 'Dynamic') throw new AgentHostError('PROVISIONING_FAILED', 'Hyper-V Golden Disk must be a dynamic VHDX', { retryable: false })
  if (!golden.IsReadOnly) throw new AgentHostError('PROVISIONING_FAILED', 'Hyper-V Golden Disk must be protected by the read-only file attribute', { retryable: false })
  if (golden.FileSize >= golden.Size * THIN_DISK_MATERIALIZATION_RATIO) throw new AgentHostError('PROVISIONING_FAILED', `Hyper-V Golden Disk is not thin (${golden.FileSize}/${golden.Size} bytes)`, { retryable: false })
  if (placeholder.VhdType !== 'Dynamic'
    || placeholder.Size !== golden.Size
    || placeholder.FileSize > PODMAN_EXPANDED_PLACEHOLDER_MAX_ALLOCATION_BYTES) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Podman Hyper-V disk is not the expected protected dynamic placeholder', { retryable: true })
  }

  const staging = resolve(dirname(destinationPath), `.${basename(destinationPath)}.diff-${process.pid}-${randomUUID()}.vhdx`)
  const backup = resolve(dirname(destinationPath), `.${basename(destinationPath)}.placeholder-${process.pid}-${randomUUID()}.bak`)
  let published = false
  try {
    await runner('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CREATE_DIFFERENCING_VHD_SCRIPT,
      staging, sourcePath,
    ])
    const child = await inspectHyperVVhd(staging, runner)
    if (child.VhdType !== 'Differencing'
      || resolve(child.ParentPath || '').toLowerCase() !== sourcePath.toLowerCase()
      || child.Size !== golden.Size
      || child.FileSize > PODMAN_EXPANDED_PLACEHOLDER_MAX_ALLOCATION_BYTES) {
      throw new AgentHostError('PROVISIONING_FAILED', 'Hyper-V differencing Project VM disk failed parent, size or allocation verification', { retryable: true })
    }
    await runner('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', REPLACE_VHD_SCRIPT,
      staging, destinationPath, backup,
    ])
    published = true
    const publishedChild = await inspectHyperVVhd(destinationPath, runner)
    if (publishedChild.VhdType !== 'Differencing'
      || resolve(publishedChild.ParentPath || '').toLowerCase() !== sourcePath.toLowerCase()) {
      throw new AgentHostError('PROVISIONING_FAILED', 'Published Hyper-V Project VM disk lost its immutable Golden parent', { retryable: true })
    }
    await rm(backup, { force: true })
  } catch (error) {
    if (published) {
      const backupExists = await access(backup).then(() => true).catch(() => false)
      if (backupExists) {
        await rm(destinationPath, { force: true }).catch(() => undefined)
        await rename(backup, destinationPath).catch(() => undefined)
      }
    }
    if (error instanceof AgentHostError) throw error
    throw new AgentHostError('PROVISIONING_FAILED', `Hyper-V differencing disk creation failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
  } finally {
    await rm(staging, { force: true }).catch(() => undefined)
    if (!published) await rm(backup, { force: true }).catch(() => undefined)
  }
}

async function validatePodmanDiskPlaceholder(path: string, expandedLogicalBytes?: number): Promise<void> {
  const stats = await lstat(path).catch((error) => {
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `Podman Project VM disk placeholder is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true },
    )
  })
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new AgentHostError('PROVISIONING_FAILED', `Podman Project VM disk placeholder is not a regular file: ${path}`, { retryable: true })
  }
  const allowedLogicalSizes = new Set([PODMAN_INIT_PLACEHOLDER_BYTES])
  if (expandedLogicalBytes !== undefined) allowedLogicalSizes.add(expandedLogicalBytes)
  if (!allowedLogicalSizes.has(stats.size)) {
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `Podman Project VM disk placeholder has unexpected logical size ${stats.size}; expected ${[...allowedLogicalSizes].join(' or ')}`,
      { retryable: true },
    )
  }
  if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) {
    throw new AgentHostError('PROVISIONING_FAILED', `Podman Project VM disk placeholder is group/world writable: ${path}`, { retryable: true })
  }
  const allocated = diskAllocatedBytes(stats)
  if (allocated > PODMAN_EXPANDED_PLACEHOLDER_MAX_ALLOCATION_BYTES) {
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `Podman Project VM disk placeholder materialized unexpectedly (${allocated}/${stats.size} allocated bytes)`,
      { retryable: true },
    )
  }
}

/**
 * Publish a native CoW clone over Podman's tiny initialization disk.
 *
 * Thin mode is deliberately fail-closed: unsupported filesystems, sparse-hole
 * materialization and partial clones never become bootable Project VM disks.
 */
export async function cloneThinProjectVmDisk(source: string, destination: string): Promise<void> {
  const sourcePath = resolve(source)
  const destinationPath = resolve(destination)
  if (sourcePath === destinationPath) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Project VM Golden Disk and destination must be different files', { retryable: false })
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new AgentHostError('BACKEND_NOT_CONFIGURED', `Thin Project VM disks are not supported on ${process.platform}`)
  }

  const sourceStats = await lstat(sourcePath).catch((error) => {
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `Project VM Golden Disk is unavailable at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true },
    )
  })
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new AgentHostError('PROVISIONING_FAILED', `Project VM Golden Disk is not a regular file: ${sourcePath}`, { retryable: false })
  }
  if (sourceStats.size <= 0) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Project VM Golden Disk is empty', { retryable: false })
  }

  await validatePodmanDiskPlaceholder(destinationPath, sourceStats.size)
  const destinationStats = await lstat(destinationPath)
  if (sourceStats.dev !== destinationStats.dev) {
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      'Thin Project VM Golden Disk and Podman data root must be on the same copy-on-write filesystem',
      { retryable: true },
    )
  }
  if (sourceStats.dev === destinationStats.dev && sourceStats.ino === destinationStats.ino) {
    throw new AgentHostError('PROVISIONING_FAILED', 'Project VM Golden Disk and destination resolve to the same file', { retryable: false })
  }

  const sourceAllocated = diskAllocatedBytes(sourceStats)
  if (sourceAllocated >= sourceStats.size * THIN_DISK_MATERIALIZATION_RATIO) {
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `Project VM Golden Disk is not thin (${sourceAllocated}/${sourceStats.size} allocated bytes)`,
      { retryable: false },
    )
  }

  const staging = resolve(dirname(destinationPath), `.${basename(destinationPath)}.clone-${process.pid}-${randomUUID()}.tmp`)
  let published = false
  try {
    const args = process.platform === 'darwin'
      ? ['-c', sourcePath, staging]
      : ['--reflink=always', '--sparse=always', sourcePath, staging]
    await runCommand('/bin/cp', args)
    await chmod(staging, 0o600)

    const stagingStats = await lstat(staging)
    if (!stagingStats.isFile() || stagingStats.isSymbolicLink()) {
      throw new AgentHostError('PROVISIONING_FAILED', 'Native Project VM clone did not produce a regular staging file', { retryable: true })
    }
    if (stagingStats.size !== sourceStats.size) {
      throw new AgentHostError(
        'PROVISIONING_FAILED',
        `Native Project VM clone has unexpected logical size ${stagingStats.size}; expected ${sourceStats.size}`,
        { retryable: true },
      )
    }
    const stagingAllocated = diskAllocatedBytes(stagingStats)
    const allocationTolerance = Math.max(THIN_DISK_ALLOCATION_TOLERANCE_BYTES, Math.ceil(sourceAllocated * 0.1))
    if (stagingAllocated >= stagingStats.size * THIN_DISK_MATERIALIZATION_RATIO
      || stagingAllocated > sourceAllocated + allocationTolerance) {
      throw new AgentHostError(
        'PROVISIONING_FAILED',
        `Native Project VM clone materialized unexpectedly (${stagingAllocated}/${stagingStats.size} allocated bytes; source ${sourceAllocated})`,
        { retryable: true },
      )
    }

    const stagingHandle = await open(staging, 'r+')
    try {
      await stagingHandle.sync()
    } finally {
      await stagingHandle.close()
    }
    await rename(staging, destinationPath)
    published = true

    // The file fsync above protects clone contents. Syncing the directory also
    // protects the atomic name replacement where the host filesystem permits
    // directory fsync; providers which reject it still retain atomic rename.
    const parentHandle = await open(dirname(destinationPath), 'r').catch(() => undefined)
    if (parentHandle) {
      try {
        await parentHandle.sync().catch(() => undefined)
      } finally {
        await parentHandle.close().catch(() => undefined)
      }
    }
  } catch (error) {
    if (error instanceof AgentHostError) throw error
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `Project VM base disk must support native copy-on-write cloning: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true },
    )
  } finally {
    if (!published) await rm(staging, { force: true }).catch(() => undefined)
  }
}

async function materializeIndependentDisk(source: string, destination: string): Promise<void> {
  const input = await open(source, 'r')
  let output: Awaited<ReturnType<typeof open>> | undefined
  try {
    const sourceStats = await input.stat()
    const filesystem = await statfs(dirname(destination))
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
    if (!Number.isFinite(availableBytes) || availableBytes < sourceStats.size + THICK_DISK_SAFETY_BYTES) {
      throw new AgentHostError(
        'PROVISIONING_FAILED',
        `Thick Project VM disk requires ${sourceStats.size + THICK_DISK_SAFETY_BYTES} free bytes but only ${Math.max(0, availableBytes)} are available`,
        { retryable: true },
      )
    }

    output = await open(destination, 'w', 0o600)
    const buffer = Buffer.allocUnsafe(DISK_COPY_BUFFER_BYTES)
    let position = 0
    while (position < sourceStats.size) {
      const length = Math.min(buffer.byteLength, sourceStats.size - position)
      const { bytesRead } = await input.read(buffer, 0, length, position)
      if (bytesRead === 0) throw new Error(`Unexpected end of Project VM base disk at byte ${position}`)
      let written = 0
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written)
        if (result.bytesWritten === 0) throw new Error(`Unable to materialize Project VM disk at byte ${position + written}`)
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await output.truncate(sourceStats.size)
    await output.sync()
    const destinationStats = await output.stat()
    const allocatedBytes = Number(destinationStats.blocks) * 512
    if (sourceStats.size > 0 && allocatedBytes < sourceStats.size * 0.95) {
      throw new AgentHostError(
        'PROVISIONING_FAILED',
        `Thick Project VM disk allocation is incomplete (${allocatedBytes}/${sourceStats.size} bytes)`,
        { retryable: true },
      )
    }
  } finally {
    await output?.close().catch(() => undefined)
    await input.close().catch(() => undefined)
  }
}

/**
 * Real Podman machine lifecycle. The command runner is injectable only for
 * deterministic unit tests; production always uses execFile with shell=false.
 */
export class PodmanMachineDriver implements ProjectVmMachineDriver {
  private readonly command: string
  private readonly run: ProjectVmCommandRunner
  private readonly bootstrapEnabled: boolean
  private readonly rootfulPodman: boolean
  private readonly projectBaseDisk?: string
  private readonly cloneDisk: (source: string, destination: string) => Promise<void>
  private readonly materializeDisk: (source: string, destination: string) => Promise<void>
  private readonly resolveMachineDiskPath: (name: string) => string | undefined
  private readonly machineProvider: PodmanMachineProvider
  private readonly directAppleHv: boolean
  private readonly helperBinaryDirectory?: string
  private readonly prepareHyperVNetworking?: (machineName: string) => Promise<void>
  private readonly preserveFailedMachine: boolean
  private readonly directStateRoot?: string
  private readonly directSocketRoot?: string
  readonly forwardPort?: (name: string, remotePort: number) => Promise<ProjectVmPortForward>

  constructor(options: PodmanMachineDriverOptions = {}) {
    this.command = options.command ?? 'podman'
    this.run = options.run ?? runCommand
    this.bootstrapEnabled = options.bootstrap ?? true
    this.rootfulPodman = options.rootfulPodman ?? false
    this.projectBaseDisk = options.projectBaseDisk
    this.machineProvider = options.machineProvider ?? (process.platform === 'win32' ? 'hyperv' : process.platform === 'darwin' ? 'applehv' : 'qemu')
    this.cloneDisk = options.cloneDisk ?? (this.machineProvider === 'hyperv'
      ? (source, destination) => cloneThinHyperVProjectVmDisk(source, destination, this.run)
      : cloneThinProjectVmDisk)
    this.materializeDisk = options.materializeDisk ?? materializeIndependentDisk
    this.resolveMachineDiskPath = options.machineDiskPath ?? ((name) => {
      const dataRoot = process.env.XDG_DATA_HOME?.trim()
      if (!dataRoot) return undefined
      if (this.machineProvider === 'applehv') return resolve(dataRoot, 'containers', 'podman', 'machine', 'applehv', `${name}-${process.arch}.raw`)
      if (this.machineProvider === 'hyperv') {
        const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
        return resolve(dataRoot, 'containers', 'podman', 'machine', 'hyperv', `${name}-${architecture}.vhdx`)
      }
      if (this.machineProvider === 'qemu') {
        const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
        return resolve(dataRoot, 'containers', 'podman', 'machine', 'qemu', `${name}-${architecture}.qcow2`)
      }
      return undefined
    })
    this.directAppleHv = options.directAppleHv ?? false
    this.helperBinaryDirectory = options.helperBinaryDirectory ? resolve(options.helperBinaryDirectory) : undefined
    this.prepareHyperVNetworking = options.prepareHyperVNetworking
      ?? (process.platform === 'win32' && this.machineProvider === 'hyperv' && this.helperBinaryDirectory
        ? (name) => prepareHyperVNetworking(this.helperBinaryDirectory!, name, this.run)
        : undefined)
    this.preserveFailedMachine = options.preserveFailedMachine ?? false
    this.directStateRoot = options.directStateRoot ? resolve(options.directStateRoot) : undefined
    this.directSocketRoot = options.directSocketRoot
      ? resolve(options.directSocketRoot)
      // macOS os.tmpdir() expands to /var/folders/... and can itself consume
      // most of sockaddr_un's 104-byte budget. /tmp is the canonical short
      // symlink; the per-UID directory is mode 0700 below.
      : resolve('/tmp', `openlink-applehv-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`)
    if (this.directAppleHv) {
      if (process.platform !== 'darwin') throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Direct AppleHV Project VMs require macOS')
      if (!this.helperBinaryDirectory || !this.directStateRoot) {
        throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Direct AppleHV helper and state directories are required')
      }
      this.forwardPort = this.forwardAppleHvPort.bind(this)
    }
  }

  async ensureMachine(name: string, spec: ProjectVmMachineSpec): Promise<void> {
    let inspection: ProjectVmCommandResult | undefined
    try {
      // Podman machine inspect already emits JSON. `--format json` is
      // interpreted as a literal Go-template in some bundled versions and
      // returns the word "json", which would make a running VM look stopped
      // and cause an invalid second `machine start`.
      inspection = await this.run(this.command, ['machine', 'inspect', name])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/not found|no such machine|does not exist|machine .* not found/i.test(message)) throw error
    }

    if (!inspection) {
      if (this.projectBaseDisk) {
        // Podman's custom-image path performs a byte-for-byte copy of a sparse
        // 64 GiB raw disk. On macOS this can take hours and inflate every
        // Project VM to the full logical size. Let Podman generate the unique
        // machine config/Ignition against a tiny local placeholder, then
        // replace its target disk with an APFS copy-on-write clone of the
        // immutable OpenLink base before the first boot.
        const placeholderRoot = await mkdtemp(resolve(tmpdir(), 'openlink-podman-init-'))
        const placeholder = resolve(placeholderRoot, this.machineProvider === 'hyperv' ? 'placeholder.vhdx' : 'placeholder.raw')
        try {
          if (this.machineProvider === 'hyperv') {
            await createHyperVPlaceholder(placeholder, spec.diskGb * 1024 * 1024 * 1024, this.run)
          } else {
            await writeFile(placeholder, Buffer.alloc(PODMAN_INIT_PLACEHOLDER_BYTES), { flag: 'wx', mode: 0o600 })
            await validatePodmanDiskPlaceholder(placeholder)
          }
          await this.run(this.command, [
            'machine', 'init', '--image', placeholder,
            ...(this.rootfulPodman ? ['--rootful'] : []),
            '--cpus', String(spec.cpus),
            '--memory', String(spec.memoryMb),
            '--disk-size', String(spec.diskGb),
            name,
          ])
          const created = await this.run(this.command, ['machine', 'inspect', name])
          const inspectedDestination = machineDiskPath(created.stdout)
          const destination = inspectedDestination ?? this.resolveMachineDiskPath(name)
          if (!destination) throw new AgentHostError('PROVISIONING_FAILED', `Podman machine ${name} did not expose its disk path`, { retryable: true })
          if (this.machineProvider === 'hyperv') {
            const placeholderInfo = await inspectHyperVVhd(destination, this.run)
            if (placeholderInfo.VhdType !== 'Dynamic'
              || placeholderInfo.Size !== spec.diskGb * 1024 * 1024 * 1024
              || placeholderInfo.FileSize > PODMAN_EXPANDED_PLACEHOLDER_MAX_ALLOCATION_BYTES) {
              throw new AgentHostError('PROVISIONING_FAILED', 'Podman Hyper-V machine did not preserve the protected placeholder VHDX', { retryable: true })
            }
          } else {
            await validatePodmanDiskPlaceholder(destination, spec.diskGb * 1024 * 1024 * 1024)
          }
          if (spec.diskMode === 'thin') await this.cloneDisk(this.projectBaseDisk, destination)
          else await this.materializeDisk(this.projectBaseDisk, destination)
          await this.startMachine(name)
        } catch (error) {
          if (!this.preserveFailedMachine) await this.run(this.command, ['machine', 'rm', '--force', name]).catch(() => undefined)
          throw error
        } finally {
          await rm(placeholderRoot, { recursive: true, force: true }).catch(() => undefined)
        }
      } else {
        await this.run(this.command, [
          'machine', 'init',
          ...(this.rootfulPodman ? ['--rootful'] : []),
          '--cpus', String(spec.cpus),
          '--memory', String(spec.memoryMb),
          '--disk-size', String(spec.diskGb),
          '--now',
          name,
        ])
      }
    } else {
      const state = machineState(inspection.stdout)
      const currentRootful = machineRootful(inspection.stdout)
      if (currentRootful !== undefined && currentRootful !== this.rootfulPodman) {
        if (state === 'running') await this.run(this.command, ['machine', 'stop', name])
        await this.run(this.command, ['machine', 'set', `--rootful=${this.rootfulPodman}`, name])
        await this.run(this.command, ['machine', 'start', name])
      } else if (state !== 'running') {
        await this.startMachine(name)
      }
    }

    if (this.bootstrapEnabled) await this.bootstrapToolchain(name)
  }

  async bootstrapToolchain(name: string): Promise<void> {
    const marker = `$HOME/.openlink-toolchain-v6-${this.rootfulPodman ? 'rootful' : 'rootless'}`
    const script = [
      'set -eu',
      `marker="${marker}"`,
      'if [ -f "$marker" ]; then exit 0; fi',
      // The Project VM must always originate from the immutable OpenLink
      // bootc image. There is intentionally no package-manager or host
      // fallback: a bad base image is a provisioning failure, not a session
      // bootstrap opportunity.
      'if ! command -v bootc >/dev/null 2>&1; then',
      '  echo "OpenLink Project VM is not running the required bootc base image" >&2',
      '  exit 64',
      'fi',
      'for required in git node npm pnpm python3 pip3 gcc g++ make cmake curl jq rg ssh podman; do',
      '  if ! command -v "$required" >/dev/null 2>&1; then',
      '    echo "OpenLink Project VM base image is missing required command: $required" >&2',
      '    exit 64',
      '  fi',
      'done',
      ...(this.rootfulPodman
        ? []
        : [
            // OpenSandbox creates session containers through the Podman
            // Docker-compatible API. Keep the VM owner's UID mapped into
            // those containers so mode-0700 project/session bind mounts stay
            // private without requiring a world-writable fallback.
            'containers_config="${XDG_CONFIG_HOME:-$HOME/.config}/containers"',
            'mkdir -p "$containers_config"',
            'containers_file="$containers_config/containers.conf"',
            `if ! grep -q '^[[:space:]]*userns[[:space:]]*=' "$containers_file" 2>/dev/null; then if grep -q '^[[:space:]]*\\[containers\\][[:space:]]*$' "$containers_file" 2>/dev/null; then sed -i '/^[[:space:]]*\\[containers\\][[:space:]]*$/a userns = "keep-id"' "$containers_file"; else printf '[containers]\\nuserns = "keep-id"\\n' >> "$containers_file"; fi; fi`,
          ]),
      ...(this.rootfulPodman
        ? [
            // Rootful here means rootful *inside* the Project VM. It is
            // required by OpenSandbox's nftables egress sidecars.
            'if command -v systemctl >/dev/null 2>&1; then sudo loginctl enable-linger "$USER"; sudo systemctl enable --now podman.socket; else nohup sudo -n podman system service --time=0 "unix:///run/podman/podman.sock" >/tmp/openlink-rootful-podman-service.log 2>&1 & fi',
            'for attempt in $(seq 1 20); do if test -S /run/podman/podman.sock; then break; fi; sleep 0.5; done',
            'test -S /run/podman/podman.sock',
          ]
        : [
            // Local Podman Machine remains rootless by default. Its user
            // socket is sufficient for OpenSandbox control-plane access;
            // egress sidecars are disabled by the service capability profile
            // because rootless containers cannot install NET_ADMIN rules.
            'uid="$(id -u)"',
            'runtime="${XDG_RUNTIME_DIR:-/run/user/$uid}"',
            'mkdir -p "$runtime/podman"',
            'if command -v systemctl >/dev/null 2>&1; then sudo loginctl enable-linger "$USER"; systemctl --user enable --now podman.socket; else nohup podman system service --time=0 "unix://$runtime/podman/podman.sock" >/tmp/openlink-podman-service.log 2>&1 & fi',
            'for attempt in $(seq 1 20); do if test -S "$runtime/podman/podman.sock"; then break; fi; sleep 0.5; done',
            'test -S "$runtime/podman/podman.sock"',
          ]),
      'touch "$marker"',
    ].join('\n')
    await this.runInMachine(name, 'bash', ['-lc', script])
  }

  async runInMachine(name: string, command: string, args: string[] = []): Promise<ProjectVmCommandResult> {
    if (this.directAppleHv) {
      const config = await this.appleHvMachineConfig(name)
      return runCommand('/usr/bin/ssh', [
        ...this.appleHvSshOptions(config),
        `${this.appleHvRemoteUsername(config)}@127.0.0.1`,
        [command, ...args].map(shellQuote).join(' '),
      ])
    }
    return this.run(this.command, ['machine', 'ssh', name, [command, ...args].map(shellQuote).join(' ')])
  }

  async copyToMachine(name: string, sourcePath: string, destinationPath: string): Promise<void> {
    if (this.directAppleHv) {
      const config = await this.appleHvMachineConfig(name)
      await runCommand('/usr/bin/scp', [
        '-P', String(config.SSH.Port),
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=10',
        '-i', config.SSH.IdentityPath,
        sourcePath,
        `${this.appleHvRemoteUsername(config)}@127.0.0.1:${destinationPath}`,
      ])
      return
    }
    await this.run(this.command, ['machine', 'cp', sourcePath, `${name}:${destinationPath}`])
  }

  async stopMachine(name: string): Promise<void> {
    if (this.directAppleHv) {
      await this.stopDirectAppleHv(name)
      return
    }
    await this.run(this.command, ['machine', 'stop', name])
  }

  async removeMachine(name: string): Promise<void> {
    if (this.directAppleHv) await this.stopDirectAppleHv(name)
    await this.run(this.command, ['machine', 'rm', '--force', name])
    if (this.directAppleHv) {
      await Promise.all([
        rm(this.appleHvStateDirectory(name), { recursive: true, force: true }),
        rm(this.appleHvSocketDirectory(name), { recursive: true, force: true }),
      ])
    }
  }

  private async startMachine(name: string): Promise<void> {
    if (this.directAppleHv) await this.startDirectAppleHv(name)
    else {
      await this.prepareHyperVNetworking?.(name)
      try {
        await this.run(this.command, ['machine', 'start', name])
      } catch (error) {
        // Podman 6.0.x on Windows can panic while collecting the completed
        // Hyper-V WMI job even though the VM, gvproxy and SSH transport are
        // already live. Reconcile the durable target state before surfacing
        // the command error; never accept inspect alone as proof of readiness.
        if (this.machineProvider !== 'hyperv' || !await this.reconcileHyperVStart(name)) throw error
      }
    }
  }

  private async reconcileHyperVStart(name: string): Promise<boolean> {
    for (let attempt = 0; attempt < HYPERV_START_RECONCILE_ATTEMPTS; attempt += 1) {
      try {
        const inspection = await this.run(this.command, ['machine', 'inspect', name])
        if (machineState(inspection.stdout) === 'running') {
          await this.run(this.command, ['machine', 'ssh', name, 'true'])
          return true
        }
      } catch {
        // The helper or SSH listener may still be converging after Hyper-V
        // completed the asynchronous start job. Retry within a bounded window.
      }
      if (attempt + 1 < HYPERV_START_RECONCILE_ATTEMPTS) await delay(HYPERV_START_RECONCILE_DELAY_MS)
    }
    return false
  }

  private appleHvConfigRoot(): string {
    const root = process.env.XDG_CONFIG_HOME?.trim()
    if (!root) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'XDG_CONFIG_HOME is required for direct AppleHV Project VMs')
    return resolve(root, 'containers', 'podman', 'machine', 'applehv')
  }

  private appleHvStateDirectory(name: string): string {
    if (!this.directStateRoot) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Direct AppleHV state root is missing')
    return resolve(this.directStateRoot, name)
  }

  private appleHvSocketDirectory(name: string): string {
    if (!this.directSocketRoot) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Direct AppleHV socket root is missing')
    const directory = resolve(this.directSocketRoot, name)
    // Darwin's sockaddr_un.sun_path is 104 bytes including the terminator.
    // Check the longest filename before launching helpers so a configured
    // path cannot fail later as an opaque gvproxy "invalid argument" error.
    if (Buffer.byteLength(resolve(directory, 'podman-api.sock')) >= 104) {
      throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Direct AppleHV socket root is too long for macOS Unix sockets')
    }
    return directory
  }

  private async appleHvMachineConfig(name: string): Promise<AppleHvMachineConfig> {
    const path = resolve(this.appleHvConfigRoot(), `${name}.json`)
    const config = JSON.parse(await readFile(path, 'utf8')) as AppleHvMachineConfig
    const endpoint = config.AppleHypervisor?.Vfkit?.Endpoint
    const values = [config.ImagePath?.Path, config.SSH?.IdentityPath, config.AppleHypervisor?.Vfkit?.VirtualMachine?.bootloader?.efiVariableStorePath]
    if (config.Name !== name || !values.every((value) => typeof value === 'string' && value.startsWith('/')) || !/^http:\/\/localhost:\d+$/.test(endpoint ?? '')) {
      throw new AgentHostError('PROVISIONING_FAILED', `Podman AppleHV machine ${name} has an invalid configuration`, { retryable: true })
    }
    if (!Number.isSafeInteger(config.SSH.Port) || config.SSH.Port < 1024 || config.SSH.Port > 65_535 || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(config.SSH.RemoteUsername)) {
      throw new AgentHostError('PROVISIONING_FAILED', `Podman AppleHV machine ${name} has an invalid SSH configuration`, { retryable: true })
    }
    for (const mount of config.Mounts ?? []) {
      if (mount.Type !== 'virtiofs'
        || typeof mount.Source !== 'string'
        || !mount.Source.startsWith('/')
        || mount.Source.includes(',')
        || typeof mount.Target !== 'string'
        || !mount.Target.startsWith('/')
        || !/^[a-f0-9]{40}$/i.test(mount.Tag)) {
        throw new AgentHostError('PROVISIONING_FAILED', `Podman AppleHV machine ${name} has an invalid virtio-fs mount`, { retryable: false })
      }
    }
    return config
  }

  private appleHvSshOptions(config: AppleHvMachineConfig): string[] {
    return [
      '-p', String(config.SSH.Port),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=3',
      '-i', config.SSH.IdentityPath,
    ]
  }

  private appleHvRemoteUsername(config: AppleHvMachineConfig): string {
    // Podman writes the same machine key for both users. Rootful Project VMs
    // must use the root connection because /run/podman is intentionally not
    // traversable by the unprivileged image user.
    return this.rootfulPodman ? 'root' : config.SSH.RemoteUsername
  }

  private async startDirectAppleHv(name: string): Promise<void> {
    const config = await this.appleHvMachineConfig(name)
    const stateDirectory = this.appleHvStateDirectory(name)
    const socketDirectory = this.appleHvSocketDirectory(name)
    const statePath = resolve(stateDirectory, 'processes.json')
    const existing = await readFile(statePath, 'utf8')
      .then((value) => JSON.parse(value) as DirectAppleHvState)
      .catch(() => undefined)
    if (existing) {
      const vfkitRunning = processIsRunning(existing.vfkitPid)
      const gvproxyRunning = processIsRunning(existing.gvproxyPid)
      if (vfkitRunning && gvproxyRunning) {
        try {
          await this.waitForAppleHvSsh(config, existing.vfkitPid)
          return
        } catch {
          // A prior host crash may leave helpers alive while the guest is stuck
          // before SSH. Tear down that exact process pair and perform a clean
          // launch instead of treating PIDs alone as runtime readiness.
        }
      }
      // Podman may stop vfkit while leaving the direct driver's gvproxy alive
      // (or vice versa). Always reap the surviving half before unlinking and
      // rebinding this Project VM's sockets.
      await this.stopDirectAppleHv(name)
    }

    await Promise.all([
      mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
      mkdir(socketDirectory, { recursive: true, mode: 0o700 }),
    ])
    const networkSocket = resolve(socketDirectory, 'gvproxy.sock')
    const apiSocket = resolve(socketDirectory, 'podman-api.sock')
    const readySocket = resolve(socketDirectory, 'ready.sock')
    const serialLog = resolve(stateDirectory, 'serial.log')
    const gvproxyLog = resolve(stateDirectory, 'gvproxy.log')
    const gvproxyPidFile = resolve(stateDirectory, 'gvproxy.pid')
    const vfkitPidFile = resolve(stateDirectory, 'vfkit.pid')
    await Promise.all([networkSocket, apiSocket, readySocket, gvproxyPidFile, vfkitPidFile].map((path) => rm(path, { force: true })))

    const gvproxy = spawn(resolve(this.helperBinaryDirectory!, 'gvproxy'), [
      '-mtu', '1500',
      '-ssh-port', String(config.SSH.Port),
      '-listen-vfkit', `unixgram://${networkSocket}`,
      '-forward-user', this.appleHvRemoteUsername(config),
      '-forward-identity', config.SSH.IdentityPath,
      '-forward-sock', apiSocket,
      '-forward-dest', '/run/podman/podman.sock',
      '-pid-file', gvproxyPidFile,
      '-log-file', gvproxyLog,
    ], { detached: true, stdio: 'ignore', shell: false })
    if (!gvproxy.pid) throw new AgentHostError('PROVISIONING_FAILED', `Unable to launch gvproxy for ${name}`, { retryable: true })
    gvproxy.unref()

    let readyServer: Server | undefined
    let vfkitPid: number | undefined
    try {
      const socketDeadline = Date.now() + 10_000
      while (Date.now() < socketDeadline) {
        if (!processIsRunning(gvproxy.pid!)) throw new Error('gvproxy exited before its network socket became ready')
        if (await access(networkSocket).then(() => true).catch(() => false)) break
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      }
      if (!await access(networkSocket).then(() => true).catch(() => false)) throw new Error('gvproxy network socket did not become ready')

      // Podman's Ignition installs ready.service, which connects from the
      // guest to host CID 2 / port 1025. The virtio-vsock device needs a live
      // Unix listener before vfkit starts or systemd isolates to emergency.
      readyServer = createServer((socket) => socket.resume())
      readyServer.unref()
      await new Promise<void>((resolveListen, rejectListen) => {
        readyServer!.once('error', rejectListen)
        readyServer!.listen(readySocket, resolveListen)
      })

      const endpoint = config.AppleHypervisor.Vfkit.Endpoint.replace(/^http:/, 'tcp:')
      const vfkitArgs = [
        '--cpus', String(config.Resources.CPUs),
        '--memory', String(config.Resources.Memory),
        '--bootloader', `efi,variable-store=${config.AppleHypervisor.Vfkit.VirtualMachine.bootloader.efiVariableStorePath},create`,
        '--device', `virtio-blk,path=${config.ImagePath.Path}`,
        '--device', 'virtio-rng',
        '--device', `virtio-serial,logFilePath=${serialLog}`,
        '--device', `virtio-vsock,port=1025,socketURL=${readySocket},listen`,
        '--device', `virtio-net,unixSocketPath=${networkSocket},mac=${APPLEHV_MAC_ADDRESS}`,
        '--timesync', 'vsockPort=1234',
        '--restful-uri', endpoint,
        '--pidfile', vfkitPidFile,
      ]
      for (const mount of config.Mounts ?? []) {
        vfkitArgs.push('--device', `virtio-fs,sharedDir=${mount.Source},mountTag=${mount.Tag}`)
      }
      const firstBootMarker = resolve(stateDirectory, 'first-boot-complete')
      const hasDirectBootMarker = await access(firstBootMarker).then(() => true).catch(() => false)
      const isFirstBoot = !hasDirectBootMarker && !appleHvMachineHasBooted(config)
      // Podman may have booted this Project VM before the runtime was upgraded
      // to direct AppleHV process management. In that case the per-driver
      // marker does not exist, but replaying Ignition against an already
      // provisioned Fedora CoreOS disk is incorrect. LastUp is Podman's
      // durable first-boot authority; the zero Go timestamp means never booted.
      if (isFirstBoot) {
        const ignition = resolve(this.appleHvConfigRoot(), `${name}.ign`)
        if (await access(ignition).then(() => true).catch(() => false)) vfkitArgs.push('--ignition', ignition)
      }
      const vfkit = spawn(resolve(this.helperBinaryDirectory!, 'vfkit'), vfkitArgs, { detached: true, stdio: 'ignore', shell: false })
      if (!vfkit.pid) throw new Error('vfkit did not provide a process id')
      vfkitPid = vfkit.pid
      vfkit.unref()
      await writeFile(statePath, `${JSON.stringify({ machineName: name, vfkitPid: vfkit.pid, gvproxyPid: gvproxy.pid, createdAt: new Date().toISOString() } satisfies DirectAppleHvState)}\n`, { mode: 0o600 })
      await this.waitForAppleHvSsh(config, vfkit.pid)
      await closeServer(readyServer)
      readyServer = undefined
      await writeFile(firstBootMarker, `${new Date().toISOString()}\n`, { mode: 0o600 })
    } catch (error) {
      await closeServer(readyServer).catch(() => undefined)
      if (vfkitPid && processIsRunning(vfkitPid)) process.kill(vfkitPid, 'SIGTERM')
      if (processIsRunning(gvproxy.pid!)) process.kill(gvproxy.pid!, 'SIGTERM')
      await rm(statePath, { force: true })
      throw new AgentHostError('PROVISIONING_FAILED', `Direct AppleHV machine ${name} failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
  }

  private async waitForAppleHvSsh(config: AppleHvMachineConfig, vfkitPid?: number): Promise<void> {
    const deadline = Date.now() + 180_000
    let lastError: unknown
    while (Date.now() < deadline) {
      if (vfkitPid && !processIsRunning(vfkitPid)) throw new Error('vfkit exited before SSH became ready')
      try {
        await runCommand('/usr/bin/ssh', [...this.appleHvSshOptions(config), `${this.appleHvRemoteUsername(config)}@127.0.0.1`, 'true'])
        return
      } catch (error) {
        lastError = error
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
      }
    }
    throw new Error(`SSH did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  private async stopDirectAppleHv(name: string): Promise<void> {
    const statePath = resolve(this.appleHvStateDirectory(name), 'processes.json')
    const state = await readFile(statePath, 'utf8').then((value) => JSON.parse(value) as DirectAppleHvState).catch(() => undefined)
    if (!state) return

    // A direct vfkit SIGTERM is equivalent to pulling power from the guest.
    // Besides forcing PostgreSQL crash recovery, it can leave /boot journal
    // state unreadable to firmware/GRUB on the next launch. Ask systemd to
    // stop containers and unmount filesystems first; SSH normally disconnects
    // as shutdown begins, so command failure here is expected. A bounded hard
    // stop remains necessary for a wedged or never-booted guest.
    if (processIsRunning(state.vfkitPid)) {
      const config = await this.appleHvMachineConfig(name).catch(() => undefined)
      if (config) {
        await runCommand('/usr/bin/ssh', [
          ...this.appleHvSshOptions(config),
          `${this.appleHvRemoteUsername(config)}@127.0.0.1`,
          this.rootfulPodman ? 'systemctl poweroff' : 'sudo -n systemctl poweroff',
        ], 10_000).catch(() => undefined)
        await waitForProcessExit(state.vfkitPid, APPLEHV_GRACEFUL_SHUTDOWN_TIMEOUT_MS)
      }
      if (processIsRunning(state.vfkitPid)) {
        process.kill(state.vfkitPid, 'SIGTERM')
        await waitForProcessExit(state.vfkitPid)
        if (processIsRunning(state.vfkitPid)) process.kill(state.vfkitPid, 'SIGKILL')
      }
    }
    if (processIsRunning(state.gvproxyPid)) {
      process.kill(state.gvproxyPid, 'SIGTERM')
      await waitForProcessExit(state.gvproxyPid)
      if (processIsRunning(state.gvproxyPid)) process.kill(state.gvproxyPid, 'SIGKILL')
    }
    await rm(statePath, { force: true })
  }

  private async forwardAppleHvPort(name: string, remotePort: number): Promise<ProjectVmPortForward> {
    if (!Number.isSafeInteger(remotePort) || remotePort < 1024 || remotePort > 65_535) throw new AgentHostError('INVALID_TARGET', 'Project VM forward port is invalid')
    const config = await this.appleHvMachineConfig(name)
    const localPort = await availablePort()
    const child = spawn('/usr/bin/ssh', [
      ...this.appleHvSshOptions(config),
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      `${this.appleHvRemoteUsername(config)}@127.0.0.1`,
    ], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192) })
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(resolveReady, 500)
      child.once('error', (error) => { clearTimeout(timeout); rejectReady(error) })
      child.once('exit', (code) => { clearTimeout(timeout); rejectReady(new AgentHostError('PROVISIONING_FAILED', `Project VM SSH tunnel exited with ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`)) })
    })
    return {
      localPort,
      close: async () => {
        if (child.exitCode !== null) return
        child.kill('SIGTERM')
        await Promise.race([
          new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
          new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5_000)),
        ])
        if (child.exitCode === null) child.kill('SIGKILL')
      },
    }
  }
}

export interface ProjectVmManagerOptions {
  stateRoot: string
  machineDriver: ProjectVmMachineDriver
  machinePrefix?: string
  /** Absolute path inside each Linux project VM for the project workspace. */
  guestWorkspaceRoot?: string
  machineSpec?: ProjectVmMachineSpec
  backend?: ProjectVmBackend
}

export class ProjectVmManager {
  private readonly stateRoot: string
  private readonly machineDriver: ProjectVmMachineDriver
  private readonly machinePrefix: string
  private readonly guestWorkspaceRoot: string
  private readonly machineSpec: ProjectVmMachineSpec
  private readonly backend: ProjectVmBackend

  constructor(options: ProjectVmManagerOptions) {
    this.stateRoot = resolve(options.stateRoot)
    this.machineDriver = options.machineDriver
    this.machinePrefix = (options.machinePrefix ?? 'olp').replace(/-+$/, '')
    if (!/^[a-z0-9][a-z0-9-]{0,20}$/.test(this.machinePrefix)) {
      throw new AgentHostError('INVALID_BODY', 'machinePrefix is invalid or too long')
    }
    const guestRoot = options.guestWorkspaceRoot ?? '/var/lib/openlink/projects'
    if (!/^\/[A-Za-z0-9._/-]+$/.test(guestRoot) || guestRoot.includes('..')) {
      throw new AgentHostError('INVALID_BODY', 'guestWorkspaceRoot is invalid')
    }
    this.guestWorkspaceRoot = guestRoot.replace(/\/+$/, '') || '/'
    this.machineSpec = options.machineSpec ?? { cpus: 4, memoryMb: 8_192, diskGb: 64, diskMode: 'thin' }
    this.backend = options.backend ?? 'podman-machine'
  }

  get runtimeBackend(): ProjectVmBackend {
    return this.backend
  }

  machineName(projectId: string): string {
    this.assertProjectId(projectId)
    const hashLength = Math.max(8, 30 - this.machinePrefix.length - 1)
    return `${this.machinePrefix}-${projectId.replaceAll('-', '').slice(0, hashLength)}`
  }

  workspacePath(projectId: string): string {
    this.assertProjectId(projectId)
    return `${this.guestWorkspaceRoot}/${projectId}/workspace`
  }

  async ensure(projectId: string, overrides: Partial<ProjectVmMachineSpec> = {}): Promise<ProjectVmDescriptor> {
    this.assertProjectId(projectId)
    const machineName = this.machineName(projectId)
    const workspacePath = this.workspacePath(projectId)
    const projectStateRoot = resolve(this.stateRoot, 'projects', projectId)
    const descriptorPath = resolve(projectStateRoot, 'runtime.json')
    const machineSpec = { ...this.machineSpec, ...overrides }
    let persisted: Record<string, unknown> | undefined
    await mkdir(projectStateRoot, { recursive: true, mode: 0o700 })
    try {
      persisted = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>
      const persistedMode = persisted.diskMode === 'thick' ? 'thick' : 'thin'
      if (persistedMode !== machineSpec.diskMode) {
        throw new AgentHostError(
          'PROVISIONING_FAILED',
          `Project VM disk mode is immutable (${persistedMode} != ${machineSpec.diskMode})`,
        )
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }
    await this.machineDriver.ensureMachine(machineName, machineSpec)
    // The path is deliberately guest-scoped. Host paths such as /Volumes or
    // /Users are not guaranteed to be mounted into a Podman VM and would
    // otherwise make project workspaces escape the VM boundary.
    if (this.machineDriver.runInMachine) {
      await this.machineDriver.runInMachine(machineName, 'mkdir', ['-p', workspacePath])
      await this.machineDriver.runInMachine(machineName, 'chmod', ['700', workspacePath])
    }
    const descriptor: ProjectVmDescriptor = {
      projectId,
      machineName,
      workspacePath,
      backend: this.backend,
      diskMode: machineSpec.diskMode,
      status: 'ready',
    }
    // ProjectRuntimeManager owns additional durable data in this descriptor
    // (service ports, public endpoints, and the browser-safe Supabase
    // descriptor).  Reattaching a VM after an Agent Host restart must not
    // erase that state before the higher-level manager can validate it.
    await writeFile(resolve(this.stateRoot, 'projects', projectId, 'runtime.json'), `${JSON.stringify({
      ...persisted,
      ...descriptor,
      status: 'ready',
    })}\n`, { mode: 0o600 })
    return descriptor
  }

  async stop(projectId: string): Promise<void> {
    await this.machineDriver.stopMachine(this.machineName(projectId))
  }

  async remove(projectId: string): Promise<void> {
    await this.machineDriver.removeMachine(this.machineName(projectId))
    // The state directory contains the durable descriptor and, for the
    // ProjectRuntimeManager, the VM-local service credentials. A removed VM
    // must not leave those credentials available for a later accidental
    // restore or filesystem inspection.
    await rm(resolve(this.stateRoot, 'projects', projectId), { recursive: true, force: true })
  }

  private assertProjectId(projectId: string): void {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new AgentHostError('INVALID_BODY', 'projectId is invalid')
  }
}

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
}
