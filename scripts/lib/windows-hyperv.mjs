import { runCapture } from './podman-builder.mjs'

const HOST_INSPECTION_SCRIPT = '& { $identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity); $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop; $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; $service = Get-Service vmms -ErrorAction SilentlyContinue; [pscustomobject]@{ Elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); HypervisorPresent = [bool]$computer.HypervisorPresent; VmmsStatus = [string]$service.Status; Edition = [string]$os.Caption } | ConvertTo-Json -Compress }'
const ENSURE_HYPERV_GROUP_SCRIPT = '& { $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $group = Get-LocalGroup -SID "S-1-5-32-578" -ErrorAction Stop; $present = Get-LocalGroupMember -Group $group -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $userSid }; if (-not $present) { Add-LocalGroupMember -Group $group -SID $userSid -ErrorAction Stop } }'

export function parseHyperVPrepStatus(stdout) {
  return {
    groupMember: /Current user is a member/i.test(stdout) && !/Current user is NOT a member/i.test(stdout),
    vsockReady: !/No vsock registry entries found/i.test(stdout),
  }
}

export async function inspectWindowsHyperVHost(podman, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Hyper-V host inspection is available on Windows only')
  const runner = options.runner ?? runCapture
  const commandOptions = options.commandOptions ?? {}
  const hostResult = await runner('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', HOST_INSPECTION_SCRIPT,
  ], commandOptions)
  let host
  try { host = JSON.parse(hostResult.stdout) } catch { throw new Error('Windows returned invalid Hyper-V host metadata') }
  const prepResult = await runner(podman, ['system', 'hyperv-prep', '--status'], commandOptions)
  const prep = parseHyperVPrepStatus(prepResult.stdout)
  const ready = host.HypervisorPresent === true
    && host.VmmsStatus === 'Running'
    && (host.Elevated === true || prep.groupMember)
    && (host.Elevated === true || prep.vsockReady)
  return { ...host, ...prep, ready }
}

export async function ensureWindowsHyperVGroupMembership(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Hyper-V group preparation is available on Windows only')
  const runner = options.runner ?? runCapture
  await runner('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', ENSURE_HYPERV_GROUP_SCRIPT,
  ], options.commandOptions ?? {})
}

export async function assertWindowsHyperVHostReady(podman, options = {}) {
  const status = await inspectWindowsHyperVHost(podman, options)
  if (!status.HypervisorPresent || status.VmmsStatus !== 'Running') {
    throw new Error(`OpenLink requires an active native Hyper-V host. Detected ${status.Edition || 'Windows'} with vmms=${status.VmmsStatus || 'missing'} and hypervisor=${String(status.HypervisorPresent)}.`)
  }
  if (!status.Elevated && (!status.groupMember || !status.vsockReady)) {
    throw new Error('OpenLink Windows host setup is incomplete. From an elevated PowerShell terminal run `pnpm runtime:windows:prepare`, then sign out and sign back in before starting OpenLink. WSL is not used as a fallback.')
  }
  return status
}

export { ENSURE_HYPERV_GROUP_SCRIPT, HOST_INSPECTION_SCRIPT }
