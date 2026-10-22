import { access, chmod, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { bundledToolchainPaths, prependPath, resolveHostPlatform } from './lib/host-platform.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const source = resolve(root, 'services/linux')
const output = resolve(root, '.openlink-runtime/toolchain/bin')
const hostPlatform = resolveHostPlatform()
const toolchain = bundledToolchainPaths(root)
const host = `${process.platform}-${process.arch}`
const manifestPath = resolve(root, '.openlink-runtime/toolchain/manifest.json')
const execFile = promisify(execFileCallback)
// Windows Hyper-V is a product-critical native provider. Use the current
// signed upstream stable release instead of compiling an unreleased Podman
// development branch with the host's Go toolchain. This isolates Windows from
// source-head regressions while macOS continues to use its established native
// source-build path.
const WINDOWS_PODMAN_RELEASE = Object.freeze({
  version: '6.1.4',
  installer: 'podman-installer-windows-amd64.msi',
  sha256: '4a05240054cb990629cbe098db090c5c7848c44162c11910cabb45ca75a40d53',
  url: 'https://github.com/podman-container-tools/podman/releases/download/v6.1.4/podman-installer-windows-amd64.msi',
})
// Podman 6.2 passes --map-guest-addr to pasta. Ubuntu 24.04's packaged pasta
// predates that option, so pin the current upstream static helper by digest.
const LINUX_PASTA_RELEASE = Object.freeze({
  url: 'https://passt.top/builds/latest/x86_64/pasta',
  sha256: '1b883c98a14929e4d138c934216b4a98f8af113052cdd3a7c28e0f311f8b28bf',
})

function downloadBytes(url, timeoutSeconds) {
  return new Promise((resolveDownload, rejectDownload) => {
    const child = spawn('curl', [
      '--fail', '--location', '--silent', '--show-error',
      '--retry', '8', '--retry-all-errors', '--retry-delay', '5',
      '--connect-timeout', '15', '--max-time', String(timeoutSeconds), url,
    ], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', rejectDownload)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveDownload(Buffer.concat(chunks))
      else rejectDownload(new Error(`Download failed for ${url} (${code ?? signal ?? 'unknown'}): ${stderr.trim()}`))
    })
  })
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}`))
    })
  })
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function installExecutable(sourcePath, destinationPath) {
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`
  try {
    await cp(sourcePath, temporaryPath, { force: true })
    await chmod(temporaryPath, 0o755)
    await rename(temporaryPath, destinationPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function commandExists(command) {
  try {
    await run(command, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function commandOutput(command, args, options = {}) {
  const result = await execFile(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
  return result.stdout
}

async function sourceFingerprint() {
  const [tree, diff, status] = await Promise.all([
    commandOutput('git', ['-C', root, 'rev-parse', 'HEAD:services/linux']),
    commandOutput('git', ['-C', root, 'diff', '--no-ext-diff', 'HEAD', '--', 'services/linux']),
    commandOutput('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'services/linux']),
  ])
  return createHash('sha256').update(JSON.stringify({ tree: tree.trim(), diff, status })).digest('hex')
}

function goArchitecture() {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'amd64'
  throw new Error(`OpenLink cannot build Podman for ${host}`)
}

async function buildWindowsRemote(go, outputPath) {
  const commit = (await commandOutput('git', ['-C', root, 'rev-parse', 'HEAD:services/linux'])).trim()
  const buildInfo = String(Math.floor(Date.now() / 1000))
  const ldflags = [
    `-X go.podman.io/podman/v6/libpod/define.gitCommit=${commit}`,
    `-X go.podman.io/podman/v6/libpod/define.buildInfo=${buildInfo}`,
    '-X go.podman.io/podman/v6/libpod/config._installPrefix=/usr/local',
    '-X go.podman.io/podman/v6/libpod/config._etcDir=/etc',
    '-X go.podman.io/podman/v6/pkg/systemd/quadlet._binDir=/usr/local/bin',
    '-X go.podman.io/common/pkg/config.additionalHelperBinariesDir=',
  ].join(' ')
  const env = {
    ...process.env,
    CGO_ENABLED: '0',
    GOOS: 'windows',
    GOARCH: goArchitecture(),
    GOFLAGS: '-mod=vendor',
  }
  await run(go, [
    'build', '-trimpath',
    '-tags', 'remote exclude_graphdriver_btrfs containers_image_openpgp',
    '-ldflags', ldflags,
    '-o', outputPath,
    './cmd/podman',
  ], { cwd: source, env })
}

async function ensureWindowsStableRelease() {
  if (process.arch !== 'x64') throw new Error(`OpenLink's pinned Windows Podman release does not support ${process.arch}`)
  const toolchainRoot = resolve(root, '.openlink-runtime', 'toolchain')
  const downloadDirectory = resolve(toolchainRoot, 'downloads')
  const installerPath = resolve(downloadDirectory, WINDOWS_PODMAN_RELEASE.installer)
  await mkdir(downloadDirectory, { recursive: true, mode: 0o700 })
  let validInstaller = false
  try {
    const checksum = createHash('sha256').update(await readFile(installerPath)).digest('hex')
    validInstaller = checksum === WINDOWS_PODMAN_RELEASE.sha256
  } catch {}
  if (!validInstaller) await downloadVerified(WINDOWS_PODMAN_RELEASE.url, installerPath, WINDOWS_PODMAN_RELEASE.sha256)

  const extractionRoot = await mkdtemp(resolve(toolchainRoot, `podman-${WINDOWS_PODMAN_RELEASE.version}-`))
  try {
    await run('msiexec.exe', ['/a', installerPath, '/qn', `TARGETDIR=${extractionRoot}`])
    const releaseBin = resolve(extractionRoot, 'PFiles64', 'Podman')
    for (const [sourceName, destination] of [
      ['podman.exe', toolchain.podman],
      ['gvproxy.exe', toolchain.gvproxy],
      ['win-sshproxy.exe', toolchain.winSshProxy],
    ]) {
      const sourcePath = resolve(releaseBin, sourceName)
      if (!(await executable(sourcePath))) throw new Error(`Pinned Podman ${WINDOWS_PODMAN_RELEASE.version} installer is missing ${sourceName}`)
      await cp(sourcePath, destination, { force: true })
      await chmod(destination, 0o755)
    }
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

async function ensureWindowsHelpers(go) {
  if (process.platform !== 'win32') return
  const required = [toolchain.gvproxy, toolchain.winSshProxy]
  if ((await Promise.all(required.map(executable))).every(Boolean)) return
  const helperEnv = {
    ...process.env,
    CGO_ENABLED: '0',
    GOOS: 'windows',
    GOARCH: goArchitecture(),
    GOBIN: output,
    GOPATH: resolve(root, '.openlink-runtime', 'toolchain', 'go-work'),
    GOMODCACHE: resolve(root, '.openlink-runtime', 'toolchain', 'go-mod-cache'),
    GOFLAGS: '-mod=mod',
  }
  if (!(await executable(toolchain.gvproxy))) {
    await run(go, ['install', 'github.com/containers/gvisor-tap-vsock/cmd/gvproxy@v0.9.0'], { cwd: source, env: helperEnv })
  }
  if (!(await executable(toolchain.winSshProxy))) {
    await run(go, ['install', 'github.com/containers/gvisor-tap-vsock/cmd/win-sshproxy@v0.9.0'], { cwd: source, env: helperEnv })
  }
}

async function buildWithHostGo() {
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    await run('make', ['GOOS=darwin', 'GOARCH=arm64', 'podman-remote'], { cwd: source, env })
    await installExecutable(resolve(source, 'bin/darwin/podman'), resolve(output, 'podman'))
    await run('go', ['install', 'github.com/crc-org/vfkit/cmd/vfkit@v0.6.4'], { cwd: source, env: { ...env, GOBIN: output, GOFLAGS: '-mod=mod' } })
    await run('go', ['install', 'github.com/containers/gvisor-tap-vsock/cmd/gvproxy@v0.9.0'], { cwd: source, env: { ...env, GOBIN: output, GOFLAGS: '-mod=mod' } })
  } else if (process.platform === 'linux') {
    await run('make', ['GOOS=linux', `GOARCH=${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, 'podman'], { cwd: source, env })
    await installExecutable(resolve(source, 'bin/podman'), resolve(output, 'podman'))
  } else if (process.platform === 'win32') {
    const go = await ensureGo()
    await buildWindowsRemote(go, toolchain.podman)
    await ensureWindowsHelpers(go)
  } else {
    throw new Error(`Podman source bootstrap is not implemented for ${host}`)
  }
}

async function downloadVerified(url, outputPath, expectedSha256) {
  const data = await downloadBytes(url, 10 * 60)
  const digest = createHash('sha256').update(data).digest('hex')
  if (digest !== expectedSha256) throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha256}, got ${digest}`)
  await writeFile(outputPath, data, { mode: 0o755 })
  await chmod(outputPath, 0o755)
}

async function ensureGo() {
  const version = process.env.OPENLINK_GO_VERSION || 'go1.26.3'
  const versionOf = async (command) => {
    try {
      const output = await commandOutput(command, ['version'])
      return output.match(/\bgo version (go\d+\.\d+(?:\.\d+)?)/)?.[1]
    } catch {
      return undefined
    }
  }
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'windows' : undefined
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : undefined
  if (!platform || !architecture) throw new Error(`OpenLink cannot bootstrap Go for ${host}`)
  const archiveName = `${version}.${platform}-${architecture}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  const archivePath = resolve(output, archiveName)
  const goRoot = resolve(output, 'go')
  const goBinary = resolve(goRoot, 'bin', `go${hostPlatform.executableSuffix}`)
  if (await executable(goBinary) && await versionOf(goBinary) === version) return goBinary
  if (await commandExists('go') && await versionOf('go') === version) return 'go'
  {
    let releases
    try {
      releases = JSON.parse((await downloadBytes('https://go.dev/dl/?mode=json&include=all', 60)).toString('utf8'))
    } catch (error) {
      throw new Error(`Unable to discover the pinned Go toolchain: ${error instanceof Error ? error.message : String(error)}`)
    }
    const release = releases.flatMap((item) => item.files ?? []).find((file) => file.filename === archiveName)
    if (!release?.sha256) throw new Error(`Go release ${archiveName} is not available from go.dev`)
    const archiveExists = await access(archivePath, constants.R_OK).then(() => true).catch(() => false)
    if (archiveExists) {
      const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex')
      if (digest !== release.sha256) await rm(archivePath, { force: true })
    }
    if (!(await access(archivePath, constants.R_OK).then(() => true).catch(() => false))) {
      const data = await downloadBytes(`https://go.dev/dl/${archiveName}`, 10 * 60)
      const digest = createHash('sha256').update(data).digest('hex')
      if (digest !== release.sha256) throw new Error(`Checksum mismatch for ${archiveName}`)
      await writeFile(archivePath, data, { mode: 0o600 })
    }
    await rm(goRoot, { recursive: true, force: true })
    await run('tar', [process.platform === 'win32' ? '-xf' : '-xzf', archivePath, '-C', output])
    await chmod(goBinary, 0o755)
  }
  if (await versionOf(goBinary) !== version) throw new Error(`Expected Go ${version} after bootstrap`)
  return goBinary
}

async function ensureDarwinHelpers() {
  if (process.platform !== 'darwin') return
  const vfkitPath = resolve(output, 'vfkit')
  const gvproxyPath = resolve(output, 'gvproxy')
  const hasVfkit = await executable(vfkitPath)
  const hasGvproxy = await executable(gvproxyPath)
  if (hasVfkit && hasGvproxy) return

  // vfkit links Apple's Foundation/Mach frameworks and therefore cannot be
  // cross-compiled from the Linux Go container used for Podman bootstrap.
  // Prefer a local Go toolchain when available; otherwise fetch the pinned,
  // checksum-verified upstream macOS release artifacts.
  if (await commandExists('go')) {
    const env = { ...process.env, GOBIN: output, GOFLAGS: '-mod=mod' }
    if (!hasVfkit) await run('go', ['install', 'github.com/crc-org/vfkit/cmd/vfkit@v0.6.4'], { cwd: source, env })
    if (!hasGvproxy) await run('go', ['install', 'github.com/containers/gvisor-tap-vsock/cmd/gvproxy@v0.9.0'], { cwd: source, env })
    return
  }

  if (process.arch !== 'arm64') throw new Error('Pinned vfkit bootstrap currently supports macOS arm64 only')
  if (!hasVfkit) await downloadVerified(
    'https://github.com/crc-org/vfkit/releases/download/v0.6.4/vfkit',
    vfkitPath,
    '0ed83fc8ca7aa708598835480dba1362406aa7cd1dab3b27464eb76327d9652d',
  )
  if (!hasGvproxy) await downloadVerified(
    'https://github.com/containers/gvisor-tap-vsock/releases/download/v0.9.0/gvproxy-darwin',
    gvproxyPath,
    'e2a6825ba789fe588828b418c09aaf16525dec6d8cb2d16c94e72535dd4606be',
  )
}

async function ensureLinuxHelpers() {
  if (process.platform !== 'linux') return []
  const helpers = []
  const gvproxy = resolve(output, 'gvproxy')
  if (!(await executable(gvproxy))) {
    const go = await ensureGo()
    await run(go, ['install', 'github.com/containers/gvisor-tap-vsock/cmd/gvproxy@v0.9.0'], {
      cwd: source,
      env: { ...process.env, GOBIN: output, GOFLAGS: '-mod=mod' },
    })
  }
  for (const [name, candidates] of [
    ['netavark', ['/usr/lib/podman/netavark', '/usr/libexec/podman/netavark', '/usr/bin/netavark']],
    ['aardvark-dns', ['/usr/lib/podman/aardvark-dns', '/usr/libexec/podman/aardvark-dns', '/usr/bin/aardvark-dns']],
  ]) {
    const destination = resolve(output, name)
    if (!(await executable(destination))) {
      const sourcePath = (await Promise.all(candidates.map(async (candidate) => await executable(candidate) ? candidate : undefined))).find(Boolean)
      if (!sourcePath) throw new Error(`Podman requires ${name}; install it from the host distribution before building OpenLink`)
      await rm(destination, { force: true })
      await symlink(sourcePath, destination)
    }
    helpers.push(destination)
  }

  const pasta = resolve(output, 'pasta')
  if (!(await executable(pasta))) {
    if (process.arch !== 'x64') {
      throw new Error(`OpenLink needs a current pasta helper for Podman on ${process.arch}; install one that supports --map-guest-addr`)
    }
    await downloadVerified(LINUX_PASTA_RELEASE.url, pasta, LINUX_PASTA_RELEASE.sha256)
  }
  helpers.push(pasta)
  return helpers
}

await mkdir(output, { recursive: true, mode: 0o700 })
const fingerprint = await sourceFingerprint()
const podmanPath = toolchain.podman
let manifest
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {}
const requestedGoVersion = process.env.OPENLINK_GO_VERSION || 'go1.26.3'
const podmanRevision = JSON.parse(await readFile(resolve(root, 'services/source-revisions.json'), 'utf8')).services.linux
const podmanBuildCommit = `${podmanRevision.sourceCommit}${podmanRevision.openlinkPatches?.length ? '-dirty' : ''}`
const manifestMatches = process.platform === 'win32'
  ? manifest?.host === host && manifest?.provider === hostPlatform.provider && manifest?.podmanRelease === WINDOWS_PODMAN_RELEASE.version && manifest?.podmanReleaseSha256 === WINDOWS_PODMAN_RELEASE.sha256
  : manifest?.sourceFingerprint === fingerprint && manifest?.host === host && manifest?.goVersion === requestedGoVersion && manifest?.podmanBuildCommit === podmanBuildCommit
let go
if (!(await executable(podmanPath)) || !manifestMatches) {
  if (process.platform === 'win32') {
    await ensureWindowsStableRelease()
  } else {
    go = await ensureGo()
    const env = { ...process.env, GIT_COMMIT: podmanBuildCommit, GOFLAGS: '-mod=mod', PATH: prependPath(dirname(go)) }
    if (process.platform === 'darwin') {
    await run('make', ['GOOS=darwin', 'GOARCH=arm64', 'podman-remote'], { cwd: source, env })
    await installExecutable(resolve(source, 'bin/darwin/podman'), podmanPath)
    } else if (process.platform === 'linux') {
    await run('make', ['GOOS=linux', `GOARCH=${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, 'podman'], { cwd: source, env })
    await installExecutable(resolve(source, 'bin/podman'), podmanPath)
    } else {
    throw new Error(`Podman source bootstrap is not implemented for ${host}`)
    }
  }
}
await ensureDarwinHelpers()
const linuxHelpers = await ensureLinuxHelpers()
const bundledPaths = [toolchain.podman, toolchain.vfkit, toolchain.gvproxy, toolchain.winSshProxy].filter(Boolean)
const helperPaths = [...bundledPaths, ...linuxHelpers]
for (const path of bundledPaths) {
  if (await executable(path)) await chmod(path, 0o755)
}
await writeFile(manifestPath, `${JSON.stringify({ host, provider: hostPlatform.provider, sourceFingerprint: process.platform === 'win32' ? undefined : fingerprint, goVersion: process.platform === 'win32' ? undefined : requestedGoVersion, podmanBuildCommit: process.platform === 'win32' ? undefined : podmanBuildCommit, podmanRelease: process.platform === 'win32' ? WINDOWS_PODMAN_RELEASE.version : undefined, podmanReleaseSha256: process.platform === 'win32' ? WINDOWS_PODMAN_RELEASE.sha256 : undefined, podmanPath, helpers: [...[toolchain.gvproxy, toolchain.winSshProxy, toolchain.vfkit].filter(Boolean), ...linuxHelpers], generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ host, podmanPath, toolchainRoot: dirname(podmanPath), sourceFingerprint: fingerprint })}\n`)
