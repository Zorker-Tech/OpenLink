import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundledToolchainPaths, executableName, packageManagerCommand, prependPath, resolveHostPlatform, resolveUserStateRoot } from '../lib/host-platform.mjs'

test('selects the native AppleHV contract without changing existing macOS paths', () => {
  const host = resolveHostPlatform({ platform: 'darwin', architecture: 'arm64', env: {} })
  assert.equal(host.provider, 'applehv')
  assert.equal(host.diskFormat, 'raw')
  assert.equal(host.pathDelimiter, ':')
  assert.ok(host.chromiumCandidates.some((path) => path.includes('Google Chrome.app')))
  assert.match(bundledToolchainPaths('/product', 'darwin').podman.replaceAll('\\', '/'), /\/product\/.openlink-runtime\/toolchain\/bin\/podman$/)
})

test('selects the native Hyper-V/VHDX Windows contract and per-user applications', () => {
  const host = resolveHostPlatform({
    platform: 'win32',
    architecture: 'x64',
    env: {
      LOCALAPPDATA: 'C:\\Users\\developer\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    },
  })
  assert.equal(host.provider, 'hyperv')
  assert.equal(host.diskFormat, 'vhdx')
  assert.equal(host.pathDelimiter, ';')
  assert.equal(host.dockerDesktopCandidates[0], 'C:\\Users\\developer\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe')
  assert.ok(host.chromiumCandidates.some((path) => path.endsWith('Microsoft\\Edge\\Application\\msedge.exe')))
  assert.equal(bundledToolchainPaths('I:\\openlink', 'win32').podman, 'I:\\openlink\\.openlink-runtime\\toolchain\\bin\\podman.exe')
  assert.equal(bundledToolchainPaths('I:\\openlink', 'win32').winSshProxy, 'I:\\openlink\\.openlink-runtime\\toolchain\\bin\\win-sshproxy.exe')
  assert.equal(
    resolveUserStateRoot('I:\\openlink', { host, env: { LOCALAPPDATA: 'C:\\Users\\developer\\AppData\\Local' } }),
    'C:\\Users\\developer\\AppData\\Local\\OpenLink\\state',
  )
})

test('preserves repository-local state paths on macOS and fails closed without Windows user state', () => {
  const mac = resolveHostPlatform({ platform: 'darwin', architecture: 'arm64', env: {} })
  assert.match(resolveUserStateRoot('/product', { host: mac, env: {} }).replaceAll('\\', '/'), /\/product\/\.openlink-runtime$/)
  const windows = resolveHostPlatform({ platform: 'win32', architecture: 'x64', env: {} })
  assert.throws(() => resolveUserStateRoot('I:\\openlink', { host: windows, env: {} }), /LOCALAPPDATA/)
})

test('resolves argv-safe Windows executable shims and PATH delimiters', () => {
  assert.equal(executableName('podman', 'win32'), 'podman.exe')
  assert.equal(executableName('podman.exe', 'win32'), 'podman.exe')
  assert.equal(packageManagerCommand('pnpm', 'win32'), 'pnpm.cmd')
  assert.equal(packageManagerCommand('npm', 'darwin'), 'npm')
  assert.equal(prependPath('I:\\tools', 'C:\\Windows', 'win32'), 'I:\\tools;C:\\Windows')
  assert.equal(prependPath('/tools', '/usr/bin', 'linux'), '/tools:/usr/bin')
})

test('fails closed for unsupported host contracts', () => {
  assert.throws(() => resolveHostPlatform({ platform: 'freebsd', architecture: 'x64' }), /does not support host platform/)
  assert.throws(() => resolveHostPlatform({ platform: 'win32', architecture: 'ia32' }), /does not support host architecture/)
  assert.throws(() => resolveHostPlatform({ platform: 'darwin', architecture: 'x64' }), /requires macOS arm64/)
})

test('Windows host preparation has a pnpm-independent nvm4w-aware entry point', async () => {
  const source = await readFile(new URL('../prepare-windows-host.ps1', import.meta.url), 'utf8')
  assert.match(source, /Get-Command node\.exe/)
  assert.match(source, /NVM_SYMLINK/)
  assert.match(source, /C:\\nvm4w\\nodejs\\node\.exe/)
  assert.match(source, /ensure-podman-toolchain\.mjs/)
  assert.match(source, /prepare-windows-host\.mjs/)
  assert.doesNotMatch(source, /pnpm(?:\.cmd)?\s+runtime:/)
})
