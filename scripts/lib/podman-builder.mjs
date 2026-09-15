import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveHostPlatform } from './host-platform.mjs'

const WINDOWS_ORPHAN_BUILDER_INSPECTION_SCRIPT = [
  '$name = [Environment]::GetEnvironmentVariable("OPENLINK_BUILDER_MACHINE", "Process")',
  '$vm = Get-VM -Name $name -ErrorAction SilentlyContinue',
  'if ($null -eq $vm) { "null"; exit 0 }',
  '$drives = @(Get-VMHardDiskDrive -VMName $name -ErrorAction SilentlyContinue)',
  '$adapters = @(Get-VMNetworkAdapter -VMName $name -ErrorAction SilentlyContinue)',
  '[pscustomobject]@{ Name = $vm.Name; Id = $vm.Id.Guid; State = $vm.State.ToString(); DrivePaths = @($drives | ForEach-Object { [string]$_.Path }); NetworkAdapterCount = $adapters.Count } | ConvertTo-Json -Compress',
].join('; ')

const WINDOWS_ORPHAN_BUILDER_REMOVE_SCRIPT = [
  '$name = [Environment]::GetEnvironmentVariable("OPENLINK_BUILDER_MACHINE", "Process")',
  '$id = [Guid][Environment]::GetEnvironmentVariable("OPENLINK_BUILDER_VM_ID", "Process")',
  '$vm = Get-VM -Id $id -ErrorAction Stop',
  'if ($vm.Name -ne $name -or $vm.State -ne "Off") { throw "Refusing to remove a changed or running Hyper-V builder VM" }',
  'Remove-VM -VM $vm -Force -ErrorAction Stop',
].join('; ')

export function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const { input, ...spawnOptions } = options
    // Windows command shims such as npm.cmd cannot be started with CreateProcess
    // directly (Node reports EINVAL). Restrict shell dispatch to those explicit
    // cmd/bat shims; Podman, PowerShell and all untrusted command paths retain
    // shell=false.
    const windowsCommandShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    const child = spawn(command, args, { stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], shell: windowsCommandShim, timeout: 2 * 60 * 1000, killSignal: 'SIGTERM', ...spawnOptions })
    if (input !== undefined) child.stdin.end(input)
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}`))
    })
  })
}

export function runCapture(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const windowsCommandShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: windowsCommandShim, timeout: 2 * 60 * 1000, killSignal: 'SIGTERM', ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}: ${stderr.trim()}`))
    })
  })
}

export function isCompletedMachineRemovalError(error) {
  return /process already finished|unable to clean up gvproxy/i.test(error instanceof Error ? error.message : String(error))
}

export async function removePodmanMachine(podman, machineName, options = {}) {
  try {
    await run(podman, ['machine', 'rm', '--force', machineName], options)
  } catch (error) {
    // Podman can remove the machine metadata and disk successfully, then
    // return 125 because gvproxy exited before its final cleanup probe.
    // Ignore only that narrow race and only after inspect confirms the exact
    // machine no longer exists.
    if (!isCompletedMachineRemovalError(error)) throw error
    const stillExists = await runCapture(podman, ['machine', 'inspect', machineName], {
      ...options,
      timeout: 30_000,
    }).then(() => true).catch(() => false)
    if (stillExists) throw error
  }
}

async function cachedMachineImage(provider) {
  const dataRoot = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const suffixes = provider === 'hyperv' ? ['.vhdx.zst', '.vhdx'] : ['.raw.zst', '.raw']
  const roots = [
    join(dataRoot, 'containers', 'podman', 'machine', provider, 'cache'),
    ...(provider === 'applehv' ? [join(dataRoot, 'containers', 'podman', 'machine', 'libkrun', 'cache')] : []),
  ]
  const candidates = []
  for (const root of roots) {
    try {
      for (const entry of await readdir(root)) {
        if (!suffixes.some((suffix) => entry.endsWith(suffix))) continue
        const path = join(root, entry)
        const metadata = await stat(path)
        if (metadata.isFile() && metadata.size > 0) candidates.push({ path, mtime: metadata.mtimeMs })
      }
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.path
}

export function isSafeIncompleteWindowsBuilder(record, machineName) {
  return record?.Name === machineName
    && typeof record.Id === 'string'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.Id)
    && record.State === 'Off'
    && record.NetworkAdapterCount === 0
    && Array.isArray(record.DrivePaths)
    && record.DrivePaths.every((path) => path === '')
}

async function removeIncompleteWindowsBuilderMachine(machineName, options) {
  const inspection = await runCapture('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', WINDOWS_ORPHAN_BUILDER_INSPECTION_SCRIPT,
  ], { ...options, env: { ...process.env, ...options.env, OPENLINK_BUILDER_MACHINE: machineName } })
  const stdout = inspection.stdout.trim()
  if (!stdout || stdout === 'null') return false
  let record
  try { record = JSON.parse(stdout) } catch { throw new Error(`Windows returned invalid Hyper-V metadata while checking ${machineName}`) }
  if (!isSafeIncompleteWindowsBuilder(record, machineName)) {
    throw new Error(`A Hyper-V machine named ${machineName} exists but is not a safe incomplete OpenLink builder residue. Inspect and remove it explicitly; OpenLink will not delete a configured or running VM.`)
  }
  await runCapture('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', WINDOWS_ORPHAN_BUILDER_REMOVE_SCRIPT,
  ], {
    ...options,
    env: { ...process.env, ...options.env, OPENLINK_BUILDER_MACHINE: machineName, OPENLINK_BUILDER_VM_ID: record.Id },
  })
  return true
}

export async function ensurePodmanBuilder(podman, options = {}) {
  if (process.platform === 'linux') {
    await runCapture(podman, ['info'], options)
    return { connectionArgs: [], machineName: null }
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(`OpenLink's bundled image builder is not implemented for ${process.platform}`)
  }
  const provider = process.env.CONTAINERS_MACHINE_PROVIDER || resolveHostPlatform().provider
  if (process.platform === 'win32' && provider !== 'hyperv') {
    throw new Error(`Windows image production requires the native Hyper-V provider; received ${provider}`)
  }

  const machineName = process.env.OPENLINK_BUILD_MACHINE || 'openlink-image-builder'
  let machineWasRunning = false
  try {
    const machines = JSON.parse((await runCapture(podman, ['machine', 'list', '--format', 'json'], { ...options, timeout: 30_000 })).stdout)
    const active = Array.isArray(machines) ? machines.filter((machine) => machine?.Name !== machineName && (machine?.Running || machine?.Starting)) : []
    if (active.length) {
      if (process.env.OPENLINK_STOP_ACTIVE_MACHINES !== '1') {
        throw new Error(`Cannot start dedicated image builder while Project VM(s) are active: ${active.map((machine) => machine.Name).join(', ')}`)
      }
      for (const machine of active) await run(podman, ['machine', 'stop', machine.Name], options)
    }
    const own = Array.isArray(machines) ? machines.find((machine) => machine?.Name === machineName) : undefined
    machineWasRunning = Boolean(own?.Running || own?.Starting)
  } catch (error) {
    if (error instanceof Error && /Cannot start dedicated image builder/.test(error.message)) throw error
  }
  const inspect = async () => runCapture(podman, ['machine', 'inspect', machineName], { ...options, timeout: 30_000 })
  await inspect().catch(async () => {
    // A failed Hyper-V `machine init` can leave its VM registration behind
    // while Podman has no matching machine metadata. Remove only the exact
    // no-disk/no-network, powered-off residue produced by that failure mode.
    if (process.platform === 'win32') await removeIncompleteWindowsBuilderMachine(machineName, options)
    const image = await cachedMachineImage(provider)
    const imageArgs = image ? ['--image', image] : []
    await run(podman, [
      'machine', 'init', ...imageArgs,
      '--cpus', process.env.OPENLINK_BUILD_CPUS || '4',
      // Keep the dedicated artifact builder below the capacity commonly
      // reserved by Docker Desktop on 32 GiB Windows hosts. Builds remain
      // fully functional at 6 GiB; release automation can raise this via the
      // explicit OPENLINK_BUILD_MEMORY_MB override.
      '--memory', process.env.OPENLINK_BUILD_MEMORY_MB || '6144',
      '--disk-size', process.env.OPENLINK_BUILD_DISK_GB || '96',
      machineName,
    ], {
      ...options,
      // Decompressing and allocating the bootable machine disk can exceed ten
      // minutes on slower external volumes even when the cached image is
      // healthy. Keep the limit finite, but allow release hosts to tune it.
      timeout: Number(process.env.OPENLINK_BUILD_MACHINE_INIT_TIMEOUT_MS || 30 * 60_000),
      input: options.input ?? 'n\n',
    })
  })
  const inspection = await inspect()
  if (!/"(?:State|state)"\s*:\s*"running"/i.test(inspection.stdout)) {
    await run(podman, ['machine', 'start', machineName], { ...options, input: options.input ?? 'n\n' })
  }
  await configureBuilderProxy(podman, machineName, options)
  await runCapture(podman, ['--connection', machineName, 'info'], options)
  return { connectionArgs: ['--connection', machineName], machineName, machineWasRunning }
}

function guestProxy(value) {
  if (!value) return undefined
  return value
    .replaceAll('://127.0.0.1:', '://host.containers.internal:')
    .replaceAll('://localhost:', '://host.containers.internal:')
}

async function configureBuilderProxy(podman, machineName, options) {
  const values = [
    ['HTTP_PROXY', guestProxy(process.env.HTTP_PROXY || process.env.http_proxy)],
    ['HTTPS_PROXY', guestProxy(process.env.HTTPS_PROXY || process.env.https_proxy)],
    ['NO_PROXY', process.env.NO_PROXY || process.env.no_proxy],
  ].filter(([, value]) => value)
  if (!values.length) return
  const command = ['systemctl', '--user', 'set-environment', ...values.map(([key, value]) => `${key}=${value}`)]
  await run(podman, ['machine', 'ssh', machineName, command.map((value) => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ')], options)
  // Some HTTP proxies accept a single large transfer but become unstable when
  // containers/image fans out several OCI layer downloads.  This is a
  // Builder-VM-only setting: the project runtime is unaffected, while image
  // acquisition becomes deterministic through one proxy connection at a time.
  await run(podman, [
    'machine',
    'ssh',
    machineName,
    "mkdir -p ~/.config/containers/containers.conf.d && printf '[engine]\\nimage_parallel_copies = 1\\n' > ~/.config/containers/containers.conf.d/99-openlink-builder.conf",
  ], options)
  await run(podman, ['machine', 'ssh', machineName, "systemctl --user restart podman.service"], options).catch(() => undefined)
}

export async function stopPodmanBuilder(podman, machineName, options = {}) {
  if (!machineName || process.platform === 'linux') return
  await run(podman, ['machine', 'stop', machineName], options).catch(async (error) => {
    // Podman macOS may tear down gvproxy before the machine-stop command
    // receives its final acknowledgement. The machine is already stopped in
    // that state; cleanup must remain idempotent so a completed image build
    // can hand control back to the service supervisor.
    if (/not running|does not exist|not found|process already finished|unable to clean up gvproxy/i.test(error instanceof Error ? error.message : String(error))) return
    try {
      const inspection = await runCapture(podman, ['machine', 'inspect', machineName], options)
      if (!/"(?:State|state)"\s*:\s*"running"/i.test(inspection.stdout)) return
    } catch {
      // A machine that disappears during stop is already safe to clean up.
      return
    }
    throw error
  })
}

export { WINDOWS_ORPHAN_BUILDER_INSPECTION_SCRIPT, WINDOWS_ORPHAN_BUILDER_REMOVE_SCRIPT }
