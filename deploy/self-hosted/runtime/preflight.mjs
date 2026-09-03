import { constants } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { createServer } from 'node:net'
import { access, lstat, mkdir, readFile, statfs } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { normalizeTarget } from './release-contract.mjs'

const execFile = promisify(execFileCallback)
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,127}$/
const PUBLIC_SECRET = /^NEXT_PUBLIC_.*(?:SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE|API_KEY)/

export function parseEnvironmentFile(contents) {
  const result = {}
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`Invalid environment entry on line ${index + 1}`)
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (!ENVIRONMENT_KEY.test(key)) throw new Error(`Invalid environment key on line ${index + 1}`)
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate environment key ${key}`)
    if (PUBLIC_SECRET.test(key)) throw new Error(`Public environment key must not contain a secret: ${key}`)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (/\$\(|`|\$\{|\n|\r/.test(value)) throw new Error(`Shell evaluation syntax is unsafe in ${key}`)
    result[key] = value
  }
  return result
}

export async function readEnvironmentFile(path, options = {}) {
  const stats = await lstat(path)
  if (!stats.isFile()) throw new Error(`Environment path is not a regular file: ${path}`)
  if (options.secrets && (stats.mode & 0o077) !== 0) throw new Error(`Secrets file permissions must be 0600: ${path}`)
  if (!options.secrets && (stats.mode & 0o022) !== 0) throw new Error(`Environment file is writable by group or others: ${path}`)
  return parseEnvironmentFile(await readFile(path, 'utf8'))
}

async function assertFile(path, options = {}) {
  const stats = await lstat(path).catch(() => undefined)
  if (!stats?.isFile()) throw new Error(`Prebuilt release artifact is missing: ${path}`)
  if ((stats.mode & 0o022) !== 0) throw new Error(`Prebuilt release artifact is writable by group or others: ${path}`)
  if (options.executable && (stats.mode & 0o111) === 0) throw new Error(`Prebuilt release artifact is not executable: ${path}`)
}

async function command(commandPath, args, options = {}) {
  const runner = options.execFile ?? execFile
  try {
    const result = await runner(commandPath, args, { timeout: options.timeout ?? 15_000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    return typeof result === 'string' ? result : result.stdout ?? ''
  } catch (error) {
    throw new Error(`${options.label ?? commandPath} preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function assertPortAvailable(port) {
  await new Promise((resolveListen, rejectListen) => {
    const server = createServer()
    server.unref()
    server.once('error', (error) => rejectListen(new Error(`Required loopback port ${port} is unavailable: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close(resolveListen))
  })
}

export async function runPreflight(options = {}) {
  const releaseRoot = resolve(options.releaseRoot)
  const stateRoot = resolve(options.stateRoot)
  const target = normalizeTarget({ platform: options.platform ?? process.platform, architecture: options.architecture ?? process.arch })
  const checks = []
  const required = [
    ['runtime/node/bin/node', true],
    ['app/web/server.js', false],
    ['services/agent-host/dist/src/main.js', false],
    ['services/browser-host/dist/src/main.js', false],
    ['services/knowledge-service/dist/src/main.js', false],
    ['services/agent-host/dist/src/desktop-main.js', false],
    ['images/runtime/manifest.json', false],
    ['images/zokerbase/manifest.json', false],
    ['images/zero/manifest.json', false],
    ['toolchain/bin/podman', true],
    ['edge/bin/caddy', true],
    ['edge/Caddyfile', false],
    ['browser/manifest.json', false],
    ['project-vm/manifest.json', false],
    ['orchestration/docker-compose.production.yml', false],
    ['orchestration/docker-compose.zero-production.yml', false],
  ]
  for (const [relative, executable] of required) await assertFile(join(releaseRoot, ...relative.split('/')), { executable })
  const browserManifest = JSON.parse(await readFile(join(releaseRoot, 'browser/manifest.json'), 'utf8'))
  if (browserManifest.target !== target.triple || typeof browserManifest.executable !== 'string'
    || browserManifest.executable.startsWith('/') || browserManifest.executable.split('/').includes('..')) {
    throw new Error(`Chromium manifest does not match ${target.triple}`)
  }
  await assertFile(join(releaseRoot, 'browser', ...browserManifest.executable.split('/')), { executable: true })
  checks.push({ name: 'release-artifacts', status: 'pass', target: target.triple })

  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const state = await lstat(stateRoot)
  if (!state.isDirectory() || (state.mode & 0o077) !== 0) throw new Error(`State root permissions must be 0700: ${stateRoot}`)
  checks.push({ name: 'state-permissions', status: 'pass' })

  const filesystem = await statfs(stateRoot)
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
  const minimumFreeBytes = Number(options.minimumFreeBytes ?? 20 * 1024 ** 3)
  if (!Number.isFinite(minimumFreeBytes) || freeBytes < minimumFreeBytes) throw new Error(`Insufficient free disk space: ${freeBytes} bytes available, ${minimumFreeBytes} required`)
  checks.push({ name: 'disk-capacity', status: 'pass', freeBytes })

  const memoryBytes = totalmem()
  const minimumMemoryBytes = Number(options.minimumMemoryBytes ?? 16 * 1024 ** 3)
  if (!Number.isFinite(minimumMemoryBytes) || memoryBytes < minimumMemoryBytes) throw new Error(`Insufficient host memory: ${memoryBytes} bytes available, ${minimumMemoryBytes} required`)
  checks.push({ name: 'memory-capacity', status: 'pass', memoryBytes })

  if (options.hostChecks !== false) {
    const docker = options.dockerCommand ?? 'docker'
    await command(docker, ['info', '--format', '{{.ServerVersion}}'], { ...options, label: 'Docker Engine' })
    await command(docker, ['compose', 'version', '--short'], { ...options, label: 'Docker Compose' })
    checks.push({ name: 'docker-engine', status: 'pass' })
    const environment = options.environment ?? {}
    const appUrl = environment.OPENLINK_APP_URL ? new URL(environment.OPENLINK_APP_URL) : undefined
    const edgePort = appUrl ? (appUrl.port || (appUrl.protocol === 'https:' ? 443 : 80)) : undefined
    const hostPorts = [...new Set([
      environment.PORT || 3000,
      environment.OPENLINK_BROWSER_PORT || 43120,
      environment.OPENLINK_AGENT_PORT || 43121,
      environment.OPENLINK_DESKTOP_AGENT_PORT || 43123,
      environment.OPENLINK_KNOWLEDGE_PORT || 43124,
      environment.OPENLINK_STUDIO_PORT || 3002,
      environment.KONG_HTTP_PORT || 8000,
      environment.KONG_HTTPS_PORT || 8443,
      environment.POSTGRES_PORT || 54384,
      environment.POOLER_PROXY_PORT_TRANSACTION || 6543,
      environment.OPENLINK_ZERO_PORT || 19530,
      environment.OPENLINK_ZERO_HEALTH_PORT || 9091,
      ...(edgePort ? [edgePort] : []),
    ])]
    for (const value of hostPorts) {
      const port = Number(value)
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid runtime port: ${value}`)
      await assertPortAvailable(port)
    }
    checks.push({ name: 'loopback-ports', status: 'pass', ports: hostPorts.map(Number) })
    if (target.platform === 'linux') {
      await access('/dev/kvm', constants.R_OK | constants.W_OK).catch(() => {
        throw new Error('Linux Project VMs require read/write access to /dev/kvm')
      })
      const synchronized = (await command('timedatectl', ['show', '--property=NTPSynchronized', '--value'], { ...options, label: 'Linux clock synchronization' })).trim()
      if (synchronized !== 'yes') throw new Error('Linux system clock is not synchronized')
    } else {
      const value = (await command('/usr/sbin/sysctl', ['-n', 'kern.hv_support'], { ...options, label: 'Apple Hypervisor' })).trim()
      if (value !== '1') throw new Error('Apple Hypervisor support is unavailable')
      const timed = await command('/bin/launchctl', ['print', 'system/com.apple.timed'], { ...options, label: 'macOS clock synchronization service' })
      if (!/\bstate\s*=\s*running\b/.test(timed)) throw new Error('macOS clock synchronization service is not running')
    }
    checks.push({ name: 'virtualization', status: 'pass', provider: target.provider })
    checks.push({ name: 'clock-synchronization', status: 'pass' })
  }

  return { ok: true, target: target.triple, checks }
}
