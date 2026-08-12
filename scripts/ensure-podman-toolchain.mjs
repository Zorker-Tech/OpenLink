import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const source = resolve(root, 'services/linux')
const output = resolve(root, '.openlink-runtime/toolchain/bin')
const host = `${process.platform}-${process.arch}`
const manifestPath = resolve(root, '.openlink-runtime/toolchain/manifest.json')
const execFile = promisify(execFileCallback)

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
  const [head, diff, status] = await Promise.all([
    commandOutput('git', ['-C', source, 'rev-parse', 'HEAD']),
    commandOutput('git', ['-C', source, 'diff', '--no-ext-diff', 'HEAD']),
    commandOutput('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all']),
  ])
  return createHash('sha256').update(JSON.stringify({ head: head.trim(), diff, status })).digest('hex')
}

async function buildWithHostGo() {
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    await run('make', ['GOOS=darwin', 'GOARCH=arm64', 'podman-remote'], { cwd: source, env })
    await run('cp', [resolve(source, 'bin/darwin/podman'), resolve(output, 'podman')])
    await run('go', ['install', 'github.com/crc-org/vfkit/cmd/vfkit@v0.6.4'], { cwd: source, env: { ...env, GOBIN: output, GOFLAGS: '-mod=mod' } })
    await run('go', ['install', 'github.com/containers/gvisor-tap-vsock/cmd/gvproxy@v0.8.9'], { cwd: source, env: { ...env, GOBIN: output, GOFLAGS: '-mod=mod' } })
  } else if (process.platform === 'linux') {
    await run('make', ['GOOS=linux', `GOARCH=${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, 'podman'], { cwd: source, env })
    await run('cp', [resolve(source, 'bin/podman'), resolve(output, 'podman')])
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
  if (await commandExists('go')) return 'go'
  const version = process.env.OPENLINK_GO_VERSION || 'go1.25.12'
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : undefined
  if (!platform || !architecture) throw new Error(`OpenLink cannot bootstrap Go for ${host}`)
  const archiveName = `${version}.${platform}-${architecture}.tar.gz`
  const archivePath = resolve(output, archiveName)
  const goRoot = resolve(output, 'go')
  const goBinary = resolve(goRoot, 'bin', 'go')
  if (!(await executable(goBinary))) {
    let releases
    try {
      releases = JSON.parse((await downloadBytes('https://go.dev/dl/?mode=json&include=all', 60)).toString('utf8'))
    } catch (error) {
      throw new Error(`Unable to discover the pinned Go toolchain: ${error instanceof Error ? error.message : String(error)}`)
    }
    const release = releases.flatMap((item) => item.files ?? []).find((file) => file.filename === archiveName)
    if (!release?.sha256) throw new Error(`Go release ${archiveName} is not available from go.dev`)
    if (!(await executable(archivePath))) {
      const data = await downloadBytes(`https://go.dev/dl/${archiveName}`, 10 * 60)
      const digest = createHash('sha256').update(data).digest('hex')
      if (digest !== release.sha256) throw new Error(`Checksum mismatch for ${archiveName}`)
      await writeFile(archivePath, data, { mode: 0o600 })
    }
    await run('tar', ['-xzf', archivePath, '-C', output])
    await chmod(goBinary, 0o755)
  }
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
    if (!hasGvproxy) await run('go', ['install', 'github.com/containers/gvisor-tap-vsock/cmd/gvproxy@v0.8.9'], { cwd: source, env })
    return
  }

  if (process.arch !== 'arm64') throw new Error('Pinned vfkit bootstrap currently supports macOS arm64 only')
  if (!hasVfkit) await downloadVerified(
    'https://github.com/crc-org/vfkit/releases/download/v0.6.4/vfkit',
    vfkitPath,
    '0ed83fc8ca7aa708598835480dba1362406aa7cd1dab3b27464eb76327d9652d',
  )
  if (!hasGvproxy) await downloadVerified(
    'https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9/gvproxy-darwin',
    gvproxyPath,
    'c6f7b4bc7f21bf810b5cf54e04d979b014c5d96472a03a9e97fe62a00940067c',
  )
}

await mkdir(output, { recursive: true, mode: 0o700 })
const fingerprint = await sourceFingerprint()
const podmanPath = resolve(output, 'podman')
let manifest
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {}
const requestedGoVersion = process.env.OPENLINK_GO_VERSION || 'go1.25.12'
const manifestMatches = manifest?.sourceFingerprint === fingerprint && manifest?.host === host && manifest?.goVersion === requestedGoVersion
if (!(await executable(podmanPath)) || !manifestMatches) {
  const go = await ensureGo()
  const env = { ...process.env, GOFLAGS: '-mod=mod', PATH: `${dirname(go)}:${process.env.PATH || ''}` }
  if (process.platform === 'darwin') {
    await run('make', ['GOOS=darwin', 'GOARCH=arm64', 'podman-remote'], { cwd: source, env })
    await run('cp', [resolve(source, 'bin/darwin/podman'), podmanPath])
  } else if (process.platform === 'linux') {
    await run('make', ['GOOS=linux', `GOARCH=${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, 'podman'], { cwd: source, env })
    await run('cp', [resolve(source, 'bin/podman'), podmanPath])
  } else {
    throw new Error(`Podman source bootstrap is not implemented for ${host}`)
  }
}
await ensureDarwinHelpers()
for (const helper of ['podman', 'vfkit', 'gvproxy']) {
  const path = resolve(output, helper)
  if (await executable(path)) await chmod(path, 0o755)
}
await writeFile(manifestPath, `${JSON.stringify({ host, sourceFingerprint: fingerprint, goVersion: requestedGoVersion, podmanPath, generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ host, podmanPath, toolchainRoot: dirname(podmanPath), sourceFingerprint: fingerprint })}\n`)
