import { spawn } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    function onExit() {
      clearTimeout(timeout)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

function positivePort(value, fallback) {
  const port = Number(value ?? fallback)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid TCP port: ${value}`)
  return String(port)
}

export function validateProductionEnvironment(environment = {}) {
  const required = [
    'OPENLINK_STATE_ROOT',
    'OPENLINK_APP_URL',
    'OPENLINK_EDGE_ADDRESS',
    'OPENLINK_BROWSER_GATEWAY_PUBLIC_URL',
    'OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS',
    'OPENLINK_BROWSER_API_TOKEN',
    'OPENLINK_BROWSER_TOKEN_SECRET',
    'OPENLINK_AGENT_API_TOKEN',
    'OPENLINK_DESKTOP_AGENT_API_TOKEN',
    'OPENLINK_PROVIDER_SECRET_KEY',
    'OPEN_SANDBOX_API_KEY',
    'OPENLINK_KNOWLEDGE_INTERNAL_TOKEN',
    'OPENLINK_ZOKERBASE_ENV_FILE',
  ]
  for (const key of required) if (!environment[key]?.trim()) throw new Error(`Production configuration requires ${key}`)
  for (const key of required.filter((key) => /TOKEN|SECRET|API_KEY/.test(key))) {
    if (environment[key].length < 32) throw new Error(`${key} must contain at least 32 characters`)
  }
  const appUrl = new URL(environment.OPENLINK_APP_URL)
  if (appUrl.protocol !== 'https:' && environment.OPENLINK_ALLOW_INSECURE_HTTP !== '1') throw new Error('OPENLINK_APP_URL must use HTTPS in production')
  const gatewayUrl = new URL(environment.OPENLINK_BROWSER_GATEWAY_PUBLIC_URL)
  if (gatewayUrl.protocol !== 'https:' && environment.OPENLINK_ALLOW_INSECURE_HTTP !== '1') throw new Error('OPENLINK_BROWSER_GATEWAY_PUBLIC_URL must use HTTPS in production')
  return environment
}

async function imageEntries(releaseRoot, kind) {
  const manifestPath = join(releaseRoot, 'images', kind, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const entries = Array.isArray(manifest.images)
    ? manifest.images
    : Object.entries(manifest.images ?? {}).map(([image, item]) => ({ image, ...item }))
  return entries.map((entry) => {
    if (typeof entry.image !== 'string' || !entry.image || typeof entry.archive !== 'string' || !entry.archive) {
      throw new Error(`Invalid ${kind} image manifest entry`)
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.imageId ?? '')) throw new Error(`Missing immutable image ID for ${entry.image}`)
    const archive = resolve(dirname(manifestPath), entry.archive.startsWith('archives/') ? entry.archive : join('archives', entry.archive))
    if (!archive.startsWith(`${resolve(dirname(manifestPath))}/`)) throw new Error(`Image archive escapes ${kind} payload`)
    return { kind, image: entry.image, imageId: entry.imageId, archive }
  })
}

function processSpec(name, node, entrypoint, cwd, environment, healthUrl) {
  return { name, command: node, args: [entrypoint], cwd, environment, healthUrl }
}

export async function createRuntimePlan(options = {}) {
  const releaseRoot = resolve(options.releaseRoot)
  const stateRoot = resolve(options.stateRoot)
  const supplied = options.validate === false ? (options.environment ?? {}) : validateProductionEnvironment(options.environment)
  const node = join(releaseRoot, 'runtime/node/bin/node')
  const webPort = positivePort(supplied.PORT, 3000)
  const browserPort = positivePort(supplied.OPENLINK_BROWSER_PORT, 43120)
  const agentPort = positivePort(supplied.OPENLINK_AGENT_PORT, 43121)
  const desktopPort = positivePort(supplied.OPENLINK_DESKTOP_AGENT_PORT, 43123)
  const knowledgePort = positivePort(supplied.OPENLINK_KNOWLEDGE_PORT, 43124)
  const zeroPort = positivePort(supplied.OPENLINK_ZERO_PORT, 19530)
  const zeroHealthPort = positivePort(supplied.OPENLINK_ZERO_HEALTH_PORT, 9091)
  const zokerbaseEnvFile = resolve(supplied.OPENLINK_ZOKERBASE_ENV_FILE ?? join(stateRoot, 'secrets/zokerbase.env'))
  const vmManifest = JSON.parse(await readFile(join(releaseRoot, 'project-vm/manifest.json'), 'utf8').catch(() => '{}'))
  const vmDisk = typeof vmManifest.disk === 'string' ? join(releaseRoot, 'project-vm', basename(vmManifest.disk)) : ''
  const runtimeImages = await imageEntries(releaseRoot, 'runtime')
  const projectArchives = Object.fromEntries(runtimeImages.map((entry) => [entry.image, entry.archive]))
  const browserManifest = JSON.parse(await readFile(join(releaseRoot, 'browser/manifest.json'), 'utf8').catch(() => '{}'))
  if (typeof browserManifest.executable !== 'string' || browserManifest.executable.startsWith('/') || browserManifest.executable.split('/').includes('..')) {
    throw new Error('Sealed Chromium manifest is invalid')
  }
  const chromeExecutable = join(releaseRoot, 'browser', ...browserManifest.executable.split('/'))
  const environment = {
    ...supplied,
    NODE_ENV: 'production',
    OPENLINK_RUNTIME_MODE: 'local',
    NEXT_PUBLIC_OPENLINK_RUNTIME_MODE: 'local',
    PORT: webPort,
    HOSTNAME: '127.0.0.1',
    OPENLINK_BROWSER_HOST: '127.0.0.1',
    OPENLINK_BROWSER_PORT: browserPort,
    OPENLINK_BROWSER_HOST_URL: `http://127.0.0.1:${browserPort}`,
    OPENLINK_BROWSER_PUBLIC_URL: `http://127.0.0.1:${browserPort}`,
    OPENLINK_BROWSER_ALLOWED_ORIGINS: supplied.OPENLINK_BROWSER_ALLOWED_ORIGINS || supplied.OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS,
    OPENLINK_BROWSER_STORAGE_ROOT: join(stateRoot, 'browser'),
    OPENLINK_CHROME_EXECUTABLE: chromeExecutable,
    OPENLINK_AGENT_HOST: '127.0.0.1',
    OPENLINK_AGENT_PORT: agentPort,
    OPENLINK_AGENT_HOST_URL: `http://127.0.0.1:${agentPort}`,
    OPENLINK_AGENT_PUBLIC_URL: supplied.OPENLINK_BROWSER_GATEWAY_PUBLIC_URL,
    OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN: supplied.OPENLINK_APP_URL,
    OPENLINK_DESKTOP_AGENT_HOST: '127.0.0.1',
    OPENLINK_DESKTOP_AGENT_PORT: desktopPort,
    OPENLINK_DESKTOP_AGENT_HOST_URL: `http://127.0.0.1:${desktopPort}`,
    OPENLINK_KNOWLEDGE_HOST: '127.0.0.1',
    OPENLINK_KNOWLEDGE_PORT: knowledgePort,
    OPENLINK_KNOWLEDGE_SERVICE_URL: `http://127.0.0.1:${knowledgePort}`,
    OPENLINK_KNOWLEDGE_RUNTIME_ROOT: join(stateRoot, 'knowledge'),
    OPENLINK_ZERO_URL: `http://127.0.0.1:${zeroPort}`,
    OPENLINK_ZERO_HEALTH_URL: `http://127.0.0.1:${zeroHealthPort}`,
    OPENLINK_STUDIO_ORIGIN: `http://127.0.0.1:${positivePort(supplied.OPENLINK_STUDIO_PORT, 3002)}`,
    OPENLINK_NODE_EXECUTABLE: node,
    OPENLINK_AGENT_WORKSPACE_ROOT: join(stateRoot, 'workspaces'),
    OPENLINK_AGENT_STORAGE_ROOT: join(stateRoot, 'agents'),
    OPENLINK_DESKTOP_AGENT_STORAGE_ROOT: join(stateRoot, 'desktop-agents'),
    OPENLINK_PROJECT_VM_STATE_ROOT: join(stateRoot, 'project-vms'),
    OPENLINK_PROJECT_VM_BASE_DISK: vmDisk,
    OPENLINK_PROJECT_VM_BOOTSTRAP: '1',
    OPENLINK_PROJECT_VM_ROOTFUL: '1',
    OPENLINK_PODMAN_COMMAND: join(releaseRoot, 'toolchain/bin/podman'),
    OPENLINK_PODMAN_HELPER_BINARIES_DIR: join(releaseRoot, 'toolchain/bin'),
    CONTAINERS_HELPER_BINARY_DIR: join(releaseRoot, 'toolchain/bin'),
    XDG_CONFIG_HOME: join(stateRoot, 'podman/config'),
    XDG_DATA_HOME: join(stateRoot, 'podman/data'),
    OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES: JSON.stringify(projectArchives),
  }
  const docker = supplied.OPENLINK_DOCKER_COMMAND || 'docker'
  const zokerbaseRoot = join(releaseRoot, 'orchestration/backend/docker')
  const zeroRoot = join(releaseRoot, 'orchestration/services/zero')
  const productionOverlay = join(releaseRoot, 'orchestration/docker-compose.production.yml')
  const zeroProductionOverlay = join(releaseRoot, 'orchestration/docker-compose.zero-production.yml')
  const compose = [
    {
      name: 'zokerbase', command: docker, cwd: zokerbaseRoot,
      args: ['compose', '--project-name', 'zokerbase', '--env-file', zokerbaseEnvFile, '--file', join(zokerbaseRoot, 'docker-compose.yml'), '--file', join(zokerbaseRoot, 'docker-compose.zokerbase.yml'), '--file', join(zokerbaseRoot, 'docker-compose.openlink.yml'), '--file', productionOverlay, 'up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '600'],
      stopArgs: ['compose', '--project-name', 'zokerbase', '--env-file', zokerbaseEnvFile, '--file', join(zokerbaseRoot, 'docker-compose.yml'), '--file', join(zokerbaseRoot, 'docker-compose.zokerbase.yml'), '--file', join(zokerbaseRoot, 'docker-compose.openlink.yml'), '--file', productionOverlay, 'stop', '--timeout', '120'],
      environment: { ...environment, OPENLINK_ZOKERBASE_DATA_ROOT: join(stateRoot, 'zokerbase') },
    },
    {
      name: 'zero', command: docker, cwd: zeroRoot,
      args: ['compose', '--project-name', 'openlink-zero', '--file', join(zeroRoot, 'docker-compose.standalone.yml'), '--file', zeroProductionOverlay, 'up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '600'],
      stopArgs: ['compose', '--project-name', 'openlink-zero', '--file', join(zeroRoot, 'docker-compose.standalone.yml'), '--file', zeroProductionOverlay, 'stop', '--timeout', '120'],
      environment: { ...environment, OPENLINK_ZERO_DATA_ROOT: join(stateRoot, 'zero'), OPENLINK_ZERO_PORT: zeroPort, OPENLINK_ZERO_HEALTH_PORT: zeroHealthPort },
    },
  ]
  const processes = [
    processSpec('browser-host', node, join(releaseRoot, 'services/browser-host/dist/src/main.js'), join(releaseRoot, 'services/browser-host'), environment, `http://127.0.0.1:${browserPort}/healthz`),
    processSpec('knowledge-service', node, join(releaseRoot, 'services/knowledge-service/dist/src/main.js'), join(releaseRoot, 'services/knowledge-service'), environment, `http://127.0.0.1:${knowledgePort}/healthz`),
    processSpec('agent-host', node, join(releaseRoot, 'services/agent-host/dist/src/main.js'), join(releaseRoot, 'services/agent-host'), environment, `http://127.0.0.1:${agentPort}/healthz`),
    processSpec('desktop-agent-host', node, join(releaseRoot, 'services/agent-host/dist/src/desktop-main.js'), join(releaseRoot, 'services/agent-host'), environment, `http://127.0.0.1:${desktopPort}/healthz`),
    processSpec('web', node, join(releaseRoot, 'app/web/server.js'), join(releaseRoot, 'app/web'), environment, `http://127.0.0.1:${webPort}/`),
    {
      name: 'edge', command: join(releaseRoot, 'edge/bin/caddy'),
      args: ['run', '--config', join(releaseRoot, 'edge/Caddyfile'), '--adapter', 'caddyfile'],
      cwd: releaseRoot, environment, healthUrl: supplied.OPENLINK_APP_URL,
    },
  ]
  return { releaseRoot, stateRoot, docker, images: [...runtimeImages, ...await imageEntries(releaseRoot, 'zokerbase'), ...await imageEntries(releaseRoot, 'zero')], compose, processes }
}

async function defaultCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.environment }, stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', rejectCommand)
    child.once('exit', (code) => code === 0 ? resolveCommand(stdout) : rejectCommand(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.slice(-4000)}`)))
  })
}

async function defaultProbe(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3_000) })
    return response.status >= 200 && response.status < 500
  } catch { return false }
}

export class ProductionSupervisor {
  constructor(plan, dependencies = {}) {
    this.plan = plan
    this.runCommand = dependencies.runCommand ?? defaultCommand
    this.spawnProcess = dependencies.spawnProcess ?? ((command, args, options) => spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.environment }, stdio: 'inherit' }))
    this.probe = dependencies.probe ?? defaultProbe
    this.notifyReady = dependencies.notifyReady ?? (async () => {
      if (!process.env.NOTIFY_SOCKET) return
      await defaultCommand('systemd-notify', ['--ready', '--status=OpenLink production runtime is healthy'])
    })
    this.children = []
    this.stopping = false
    this.failure = new Promise((_, rejectFailure) => { this.rejectFailure = rejectFailure })
  }

  async waitForHealth(spec, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (spec.child.exitCode !== null) throw new Error(`${spec.name} exited before becoming healthy (${spec.child.exitCode})`)
      if (await this.probe(spec.healthUrl)) return
      await sleep(250)
    }
    throw new Error(`${spec.name} did not become healthy within ${timeoutMs / 1000} seconds`)
  }

  async start() {
    for (const directory of ['workspaces', 'agents', 'desktop-agents', 'browser', 'knowledge', 'project-vms', 'podman/config', 'podman/data', 'zero', 'zokerbase']) {
      await mkdir(join(this.plan.stateRoot, directory), { recursive: true, mode: 0o700 })
    }
    for (const item of this.plan.images) {
      await access(item.archive, constants.R_OK)
      const inspect = async () => (await this.runCommand(this.plan.docker, ['image', 'inspect', '--format', '{{.Id}}', item.image])).trim()
      const installedId = await inspect().catch(() => '')
      if (installedId !== item.imageId) {
        await this.runCommand(this.plan.docker, ['load', '--input', item.archive], { stdio: 'inherit' })
        const loadedId = await inspect().catch(() => '')
        if (loadedId !== item.imageId) throw new Error(`Loaded image identity does not match the signed manifest: ${item.image}`)
      }
    }
    for (const item of this.plan.compose) await this.runCommand(item.command, item.args, item)
    for (const item of this.plan.processes) {
      const child = this.spawnProcess(item.command, item.args, { ...item, openlinkName: item.name })
      const running = { ...item, child }
      this.children.push(running)
      child.once('error', (error) => { if (!this.stopping) this.rejectFailure(new Error(`${item.name} failed: ${error.message}`)) })
      child.once('exit', (code, signal) => { if (!this.stopping) this.rejectFailure(new Error(`${item.name} exited unexpectedly (${code ?? signal ?? 'unknown'})`)) })
      await this.waitForHealth(running)
    }
    await this.notifyReady()
  }

  wait() { return this.failure }

  async stop(signal = 'SIGTERM') {
    if (this.stopping) return
    this.stopping = true
    for (const item of [...this.children].reverse()) {
      if (item.child.exitCode !== null || item.child.signalCode !== null) continue
      item.child.kill(signal)
      const exited = await waitForExit(item.child, item.name === 'agent-host' ? 120_000 : 30_000)
      if (!exited && item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL')
    }
    for (const item of [...this.plan.compose].reverse()) await this.runCommand(item.command, item.stopArgs, item).catch(() => undefined)
  }
}
