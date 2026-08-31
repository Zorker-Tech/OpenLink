[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  throw 'OpenLink Windows host preparation can run on Windows only.'
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeCandidates = [Collections.Generic.List[string]]::new()
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -ne $nodeCommand -and $nodeCommand.Source) {
  $nodeCandidates.Add($nodeCommand.Source)
}
foreach ($candidate in @(
  $(if ($env:NVM_SYMLINK) { Join-Path $env:NVM_SYMLINK 'node.exe' }),
  'C:\nvm4w\nodejs\node.exe',
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }),
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' })
)) {
  if ($candidate) { $nodeCandidates.Add([IO.Path]::GetFullPath($candidate)) }
}

$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $node) {
  throw 'Node.js was not found. Install the repository-supported Windows Node.js release, then rerun this script. pnpm is not required for host preparation.'
}

Push-Location -LiteralPath $repositoryRoot
try {
  & $node (Join-Path $repositoryRoot 'scripts\ensure-podman-toolchain.mjs')
  if ($LASTEXITCODE -ne 0) { throw "OpenLink toolchain preparation failed with exit code $LASTEXITCODE." }
  & $node (Join-Path $repositoryRoot 'scripts\prepare-windows-host.mjs')
  if ($LASTEXITCODE -ne 0) { throw "OpenLink Windows host preparation failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}
