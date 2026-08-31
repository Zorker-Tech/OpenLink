import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const USER_ONLY_ACL_SCRIPT = [
  '$target = [IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable("OPENLINK_ACL_TARGET", "Process"))',
  '$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop',
  'if ($item.PSIsContainer) { throw "Secret ACL hardening accepts files only" }',
  '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$acl = New-Object Security.AccessControl.FileSecurity',
  '$acl.SetOwner($sid)',
  '$acl.SetAccessRuleProtection($true, $false)',
  '$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
  '$acl.AddAccessRule($rule) | Out-Null',
  '[IO.File]::SetAccessControl($target, $acl)',
].join('; ')

const RUNTIME_DIRECTORY_ACL_SCRIPT = [
  '$target = [IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable("OPENLINK_ACL_TARGET", "Process"))',
  '$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop',
  'if (-not $item.PSIsContainer) { throw "Runtime ACL preparation accepts directories only" }',
  '$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$systemSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")',
  '$administratorsSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")',
  // This well-known Hyper-V SID represents all VM virtual accounts.  It is
  // stable across localized and non-domain Windows installations, unlike a
  // machine-account name such as YIKE\\YIKE$, which may not resolve locally.
  '$virtualMachinesSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-83-0")',
  '$acl = New-Object Security.AccessControl.DirectorySecurity',
  '$currentOwner = $acl.GetOwner([Security.Principal.SecurityIdentifier])',
  'if ($currentOwner -ne $userSid) { $acl.SetOwner($userSid) }',
  // Hyper-V VMMS adds a concrete per-VM SID when attaching a VHDX. Keep the
  // runtime directory modifiable by VMMS; secret files below retain protected
  // current-user-only DACLs and never inherit this runtime policy.
  '$acl.SetAccessRuleProtection($false, $true)',
  '$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
  '$propagation = [Security.AccessControl.PropagationFlags]::None',
  'foreach ($sid in @($userSid, $systemSid, $administratorsSid, $virtualMachinesSid)) {',
  '  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, [Security.AccessControl.AccessControlType]::Allow)',
  '  $acl.AddAccessRule($rule) | Out-Null',
  '}',
  '[IO.Directory]::SetAccessControl($target, $acl)',
].join('; ')

const RUNTIME_DIRECTORY_HYPERV_ACCESS_CHECK_SCRIPT = [
  '$target = [IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable("OPENLINK_ACL_TARGET", "Process"))',
  '$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop',
  'if (-not $item.PSIsContainer) { throw "Hyper-V runtime access check accepts directories only" }',
  '$virtualMachinesSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-83-0")',
  '$required = [Security.AccessControl.FileSystemRights]::FullControl',
  '$rule = $item.GetAccessControl().GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference -eq $virtualMachinesSid -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($_.FileSystemRights -band $required) -eq $required) } | Select-Object -First 1',
  'if ($null -eq $rule) { throw "The Hyper-V VM virtual-account SID (S-1-5-83-0) does not have FullControl" }',
].join('; ')

function runPowerShell(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`Windows ACL hardening failed (${code ?? signal ?? 'unknown'}): ${stderr.trim()}`))
    })
  })
}

/**
 * POSIX mode bits are advisory on Windows. Apply a protected DACL containing
 * only the current user's SID to every product-owned file that carries a
 * credential. The path is passed as argv, never interpolated into PowerShell.
 */
export async function hardenUserOnlySecret(path, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return
  const runner = options.runner ?? runPowerShell
  const target = resolve(path)
  try {
    await runner('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', USER_ONLY_ACL_SCRIPT,
    ], { env: { ...process.env, OPENLINK_ACL_TARGET: target } })
  } catch (error) {
    throw new Error(`OpenLink could not apply the required user-only Windows ACL to ${target}. The workspace volume must grant the current user permission to change file ACLs; run the one-time Windows host setup from an elevated terminal. ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Prepare the product-owned runtime directory from an elevated setup process.
 * Hyper-V services need SYSTEM and VM-virtual-account access to VM disks,
 * while the interactive user must own the tree so later per-secret DACL
 * hardening works without elevation. Credential files subsequently receive a
 * protected current-user-only DACL and therefore do not inherit this access.
 */
export async function prepareWindowsRuntimeDirectory(path, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return
  const runner = options.runner ?? runPowerShell
  const target = resolve(path)
  try {
    await runner('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', RUNTIME_DIRECTORY_ACL_SCRIPT,
    ], { env: { ...process.env, OPENLINK_ACL_TARGET: target } })
  } catch (error) {
    throw new Error(`OpenLink could not prepare the Windows runtime directory ACL at ${target}. Run the one-time Windows host setup from an elevated terminal. ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Fail before Podman asks Hyper-V to create a VM. This turns Hyper-V's opaque
 * "failed to set folder permission" error into an actionable host-setup
 * requirement while still permitting macOS and Linux native providers.
 */
export async function assertWindowsRuntimeDirectoryHyperVAccess(path, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return
  const runner = options.runner ?? runPowerShell
  const target = resolve(path)
  try {
    await runner('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', RUNTIME_DIRECTORY_HYPERV_ACCESS_CHECK_SCRIPT,
    ], { env: { ...process.env, OPENLINK_ACL_TARGET: target } })
  } catch (error) {
    throw new Error(`OpenLink cannot create a native Hyper-V VM in ${target} because the Hyper-V VM virtual-account lacks required storage access. Run \`pnpm runtime:windows:prepare\` from an elevated PowerShell terminal, then retry. ${error instanceof Error ? error.message : String(error)}`)
  }
}

export { RUNTIME_DIRECTORY_ACL_SCRIPT, RUNTIME_DIRECTORY_HYPERV_ACCESS_CHECK_SCRIPT, USER_ONLY_ACL_SCRIPT }
