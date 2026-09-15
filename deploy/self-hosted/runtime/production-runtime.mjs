import { spawn } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { requestContainerBroker } from './container-broker.mjs'
import { isolationClass, resolveDeploymentProfile, resolveProjectRuntime } from './deployment-profile.mjs'

const sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const PROCESS_AMBIENT_KEYS = ['LANG', 'LC_ALL', 'PATH', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'TEMP', 'TMP', 'TMPDIR', 'TZ']
const PROCESS_IDENTITIES = {
  'browser-host': 'openlink-browser',
  'knowledge-service': 'openlink-knowledge',
  'agent-host': 'openlink-agent',
  'desktop-agent-host': 'openlink-desktop',
  web: 'openlink-web',
  edge: 'openlink-edge',
}
const BROWSER_ENVIRONMENT_KEYS = [
  'NODE_ENV', 'OPENLINK_RELEASE_ID', 'OPENLINK_RUNTIME_MODE', 'OPENLINK_BROWSER_API_TOKEN', 'OPENLINK_BROWSER_TOKEN_SECRET',
  'OPENLINK_BROWSER_HOST', 'OPENLINK_BROWSER_PORT', 'OPENLINK_BROWSER_PUBLIC_URL', 'OPENLINK_BROWSER_ALLOWED_ORIGINS',
  'OPENLINK_BROWSER_STORAGE_ROOT', 'OPENLINK_CHROME_EXECUTABLE', 'OPENLINK_BROWSER_MAX_SESSIONS',
  'OPENLINK_BROWSER_SESSION_TTL_MS', 'OPENLINK_BROWSER_CONTROL_LEASE_TTL_MS', 'OPENLINK_BROWSER_SHUTDOWN_TIMEOUT_MS',
]
const KNOWLEDGE_ENVIRONMENT_KEYS = [
  'NODE_ENV', 'OPENLINK_RELEASE_ID', 'OPENLINK_RUNTIME_MODE', 'OPENLINK_KNOWLEDGE_HOST', 'OPENLINK_KNOWLEDGE_PORT',
  'OPENLINK_KNOWLEDGE_INTERNAL_TOKEN', 'OPENLINK_KNOWLEDGE_RUNTIME_ROOT', 'OPENLINK_KNOWLEDGE_ZOKERBASE_URL',
  'OPENLINK_KNOWLEDGE_ZOKERBASE_SERVICE_KEY', 'OPENLINK_SUPABASE_SERVICE_ROLE_KEY', 'OPENLINK_LOCAL_ZOKERBASE_URL',
  'OPENLINK_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'OPENLINK_ZERO_URL', 'OPENLINK_ZERO_HEALTH_URL',
  'OPENLINK_ZERO_TOKEN', 'OPENLINK_ZERO_COLLECTION', 'OPENLINK_ZERO_DIMENSION', 'OPENLINK_EMBEDDING_BASE_URL',
  'OPENLINK_EMBEDDING_API_KEY', 'OPENAI_API_KEY', 'OPENLINK_EMBEDDING_MODEL', 'OPENLINK_EMBEDDING_PROVIDER',
  'OPENLINK_EMBEDDING_PROTOCOL', 'OPENLINK_EMBEDDING_ALLOW_DETERMINISTIC', 'OPENLINK_PROVIDER_SECRET_KEY',
  'OPENLINK_KNOWLEDGE_REQUEST_TIMEOUT_MS', 'OPENLINK_KNOWLEDGE_CHUNK_SIZE', 'OPENLINK_KNOWLEDGE_CHUNK_OVERLAP',
]
const AGENT_ENVIRONMENT_KEYS = [
  'NODE_ENV', 'OPENLINK_RELEASE_ID', 'OPENLINK_RUNTIME_MODE', 'OPENLINK_DEPLOYMENT_PROFILE', 'OPENLINK_DEPLOYMENT_PROFILE_REVISION',
  'OPENLINK_PROJECT_RUNTIME', 'OPENLINK_PROJECT_ISOLATION', 'OPENLINK_PROJECT_CONTAINER_BROKER_SOCKET', 'OPENLINK_AGENT_RELEASE_ROOT', 'OPENLINK_AGENT_API_TOKEN', 'OPEN_SANDBOX_API_KEY',
  'OPEN_SANDBOX_DOMAIN', 'OPENLINK_PROVIDER_SECRET_KEY', 'OPENLINK_SUPABASE_URL', 'OPENLINK_SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL', 'OPENLINK_AGENT_HOST', 'OPENLINK_AGENT_PORT', 'OPENLINK_AGENT_PUBLIC_URL',
  'OPENLINK_AGENT_STORAGE_ROOT', 'OPENLINK_AGENT_WORKSPACE_ROOT', 'OPENLINK_AGENT_SESSION_IDLE_TTL_MS',
  'OPENLINK_AGENT_MAX_SESSIONS', 'OPENLINK_AGENT_NETWORK_DEFAULT_ACTION', 'OPENLINK_BROWSER_GATEWAY_PUBLIC_URL',
  'OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS', 'OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN', 'OPENLINK_BROWSER_ALLOWED_ORIGINS',
  'OPENLINK_PODMAN_COMMAND', 'OPENLINK_PODMAN_HELPER_BINARIES_DIR', 'CONTAINERS_HELPER_BINARY_DIR',
  'CONTAINERS_MACHINE_PROVIDER', 'OPENLINK_PODMAN_MACHINE_PROVIDER', 'OPENLINK_PROJECT_VM_STATE_ROOT',
  'OPENLINK_PROJECT_VM_BASE_DISK', 'OPENLINK_PROJECT_VM_BOOTSTRAP', 'OPENLINK_PROJECT_VM_ROOTFUL',
  'OPENLINK_PROJECT_VM_APPLEHV_SOCKET_ROOT', 'OPENLINK_PROJECT_VM_GUEST_WORKSPACE_ROOT', 'OPENLINK_PROJECT_VM_CPUS',
  'OPENLINK_PROJECT_VM_MEMORY_MB', 'OPENLINK_PROJECT_VM_DISK_GB', 'OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES',
  'OPENLINK_PROJECT_RUNTIME_PORT_BASE', 'OPENLINK_PROJECT_RUNTIME_PORT_RANGE_SIZE', 'OPENLINK_OPENSANDBOX_SERVER_IMAGE',
  'OPENLINK_BROWSER_HOST_IMAGE', 'OPENLINK_OPENSANDBOX_EXECD_IMAGE', 'OPENLINK_OPENSANDBOX_EGRESS_IMAGE',
  'OPENLINK_AGENT_WORKER_IMAGE', 'OPENLINK_AGENT_RPC_WORKER_IMAGE', 'OPENLINK_CODE_SERVER_IMAGE',
  'OPENLINK_SSH_PROJECT_VM_STATE_ROOT', 'OPENLINK_REMOTE_RELEASE_DIR', 'OPENLINK_REMOTE_HTTP_PROXY',
  'OPENLINK_REMOTE_HTTPS_PROXY', 'OPENLINK_ALLOW_UNSAFE_ROOTLESS_PROVIDER_CREDENTIALS',
]
const DESKTOP_AGENT_ENVIRONMENT_KEYS = [
  'NODE_ENV', 'OPENLINK_RELEASE_ID', 'OPENLINK_RUNTIME_MODE', 'OPENLINK_DESKTOP_AGENT_API_TOKEN',
  'OPENLINK_PROVIDER_SECRET_KEY', 'OPENLINK_SUPABASE_URL', 'OPENLINK_SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL',
  'OPENLINK_DESKTOP_AGENT_HOST', 'OPENLINK_DESKTOP_AGENT_PORT', 'OPENLINK_DESKTOP_AGENT_PUBLIC_URL',
  'OPENLINK_DESKTOP_AGENT_STORAGE_ROOT', 'OPENLINK_AGENT_WORKSPACE_ROOT', 'OPENLINK_AGENT_SESSION_IDLE_TTL_MS',
  'OPENLINK_AGENT_MAX_SESSIONS', 'OPENLINK_NODE_EXECUTABLE', 'OPENLINK_AGENT_WORKER_ENTRYPOINT',
  'OPENLINK_AGENT_BROWSER_EXTENSION_PATH', 'OPENLINK_AGENT_SUPABASE_EXTENSION_PATH', 'OPENLINK_AGENT_ALLOWED_DOMAINS',
  'OPENLINK_AGENT_DENIED_DOMAINS', 'OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS', 'OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN',
  'OPENLINK_BROWSER_ALLOWED_ORIGINS',
]
const WEB_ENVIRONMENT_KEYS = [
  'NODE_ENV', 'OPENLINK_RELEASE_ID', 'OPENLINK_RUNTIME_MODE', 'NEXT_PUBLIC_OPENLINK_RUNTIME_MODE',
  'OPENLINK_DEPLOYMENT_PROFILE', 'OPENLINK_DEPLOYMENT_PROFILE_REVISION', 'OPENLINK_PROJECT_RUNTIME',
  'OPENLINK_PROJECT_ISOLATION', 'OPENLINK_KNOWLEDGE_ENABLED', 'OPENLINK_ZERO_ENABLED', 'PORT', 'HOSTNAME',
  'OPENLINK_APP_URL', 'OPENLINK_AGENT_API_TOKEN', 'OPENLINK_AGENT_HOST_URL', 'OPENLINK_KNOWLEDGE_INTERNAL_TOKEN',
  'OPENLINK_KNOWLEDGE_SERVICE_URL', 'OPENLINK_PROVIDER_SECRET_KEY', 'OPENLINK_STUDIO_ORIGIN',
  'OPENLINK_LOCAL_ZOKERBASE_URL', 'OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY', 'OPENLINK_LOCAL_SUPABASE_URL',
  'OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'OPENLINK_BROWSER_ALLOWED_DOMAINS', 'OPENLINK_BROWSER_DENIED_DOMAINS', 'OPENLINK_BROWSER_ALLOW_LOOPBACK',
  'OPENLINK_BROWSER_ALLOW_PRIVATE_NETWORKS', 'OPENLINK_PREVIEW_PATH_MODE', 'OPENLINK_PREVIEW_TARGET_URL',
  'OPENLINK_CLOUD_SUPABASE_URL', 'OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY', 'CROSS_APP_AUTH_SECRET', 'ZORKER_APP_URL',
]

function selectEnvironment(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}

function childEnvironment(serviceEnvironment) {
  const ambient = selectEnvironment(process.env, PROCESS_AMBIENT_KEYS)
  return { ...ambient, ...serviceEnvironment }
}

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
  const profile = resolveDeploymentProfile(environment.OPENLINK_DEPLOYMENT_PROFILE)
  resolveProjectRuntime(environment.OPENLINK_PROJECT_RUNTIME)
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
    'OPENLINK_ZOKERBASE_ENV_FILE',
  ]
  if (profile.components.knowledge) required.push('OPENLINK_KNOWLEDGE_INTERNAL_TOKEN')
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

function processSpec(name, node, entrypoint, cwd, environment, healthUrl, home) {
  return { name, identity: PROCESS_IDENTITIES[name], command: node, args: [entrypoint], cwd, environment: { ...environment, HOME: home }, healthUrl }
}

export function isolatedProcessInvocation(spec, options = {}) {
  const platform = options.platform ?? process.platform
  const root = options.root ?? (typeof process.getuid === 'function' && process.getuid() === 0)
  if (platform !== 'linux' || !root) return { command: spec.command, args: spec.args }
  if (PROCESS_IDENTITIES[spec.name] !== spec.identity) throw new Error(`Production process identity is invalid for ${spec.name}`)
  const capabilityArgs = spec.name === 'edge'
    ? ['--inh-caps=+net_bind_service', '--ambient-caps=+net_bind_service', '--bounding-set=-all,+net_bind_service']
    : ['--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all']
  return {
    command: '/usr/bin/setpriv',
    args: [`--reuid=${spec.identity}`, `--regid=${spec.identity}`, '--init-groups', ...capabilityArgs, '--no-new-privs', '--', spec.command, ...spec.args],
  }
}

export async function createRuntimePlan(options = {}) {
  const releaseRoot = resolve(options.releaseRoot)
  const stateRoot = resolve(options.stateRoot)
  const supplied = options.validate === false ? (options.environment ?? {}) : validateProductionEnvironment(options.environment)
  const profile = resolveDeploymentProfile(supplied.OPENLINK_DEPLOYMENT_PROFILE)
  const projectRuntime = resolveProjectRuntime(supplied.OPENLINK_PROJECT_RUNTIME)
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
    OPENLINK_DEPLOYMENT_PROFILE: profile.name,
    OPENLINK_DEPLOYMENT_PROFILE_REVISION: profile.revision,
    OPENLINK_PROJECT_RUNTIME: projectRuntime,
    OPENLINK_PROJECT_ISOLATION: isolationClass(projectRuntime),
    OPENLINK_KNOWLEDGE_ENABLED: profile.components.knowledge ? '1' : '0',
    OPENLINK_ZERO_ENABLED: profile.components.zero ? '1' : '0',
    NODE_ENV: 'production',
    OPENLINK_RUNTIME_MODE: 'local',
    OPENLINK_RELEASE_ID: basename(releaseRoot),
    OPENLINK_AGENT_RELEASE_ROOT: releaseRoot,
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
      environment: {
        ...environment,
        OPENLINK_ZOKERBASE_DATA_ROOT: environment.OPENLINK_ZOKERBASE_GUEST_DATA_ROOT || join(stateRoot, 'zokerbase'),
      },
    },
    ...(profile.components.zero ? [{
      name: 'zero', command: docker, cwd: zeroRoot,
      args: ['compose', '--project-name', 'openlink-zero', '--file', join(zeroRoot, 'docker-compose.standalone.yml'), '--file', zeroProductionOverlay, 'up', '--detach', '--pull', 'never', '--wait', '--wait-timeout', '600'],
      stopArgs: ['compose', '--project-name', 'openlink-zero', '--file', join(zeroRoot, 'docker-compose.standalone.yml'), '--file', zeroProductionOverlay, 'stop', '--timeout', '120'],
      environment: {
        ...environment,
        OPENLINK_ZERO_DATA_ROOT: environment.OPENLINK_ZERO_GUEST_DATA_ROOT || join(stateRoot, 'zero'),
        OPENLINK_ZERO_PORT: zeroPort,
        OPENLINK_ZERO_HEALTH_PORT: zeroHealthPort,
      },
    }] : []),
  ]
  const processes = [
    processSpec('browser-host', node, join(releaseRoot, 'services/browser-host/dist/src/main.js'), join(releaseRoot, 'services/browser-host'), selectEnvironment(environment, BROWSER_ENVIRONMENT_KEYS), `http://127.0.0.1:${browserPort}/healthz`, join(stateRoot, 'browser')),
    ...(profile.components.knowledge ? [processSpec('knowledge-service', node, join(releaseRoot, 'services/knowledge-service/dist/src/main.js'), join(releaseRoot, 'services/knowledge-service'), selectEnvironment(environment, KNOWLEDGE_ENVIRONMENT_KEYS), `http://127.0.0.1:${knowledgePort}/healthz`, join(stateRoot, 'knowledge'))] : []),
    processSpec('agent-host', node, join(releaseRoot, 'services/agent-host/dist/src/main.js'), join(releaseRoot, 'services/agent-host'), selectEnvironment(environment, AGENT_ENVIRONMENT_KEYS), `http://127.0.0.1:${agentPort}/healthz`, join(stateRoot, 'agents')),
    processSpec('desktop-agent-host', node, join(releaseRoot, 'services/agent-host/dist/src/desktop-main.js'), join(releaseRoot, 'services/agent-host'), selectEnvironment(environment, DESKTOP_AGENT_ENVIRONMENT_KEYS), `http://127.0.0.1:${desktopPort}/healthz`, join(stateRoot, 'desktop-agents')),
    processSpec('web', node, join(releaseRoot, 'app/web/server.js'), join(releaseRoot, 'app/web'), selectEnvironment(environment, WEB_ENVIRONMENT_KEYS), `http://127.0.0.1:${webPort}/api/healthz`, join(stateRoot, 'web')),
    {
      name: 'edge', command: join(releaseRoot, 'edge/bin/caddy'),
      identity: PROCESS_IDENTITIES.edge,
      args: ['run', '--config', join(releaseRoot, 'edge/Caddyfile'), '--adapter', 'caddyfile'],
      cwd: releaseRoot,
      environment: {
        HOME: join(stateRoot, 'edge'),
        OPENLINK_EDGE_ADDRESS: supplied.OPENLINK_EDGE_ADDRESS,
        XDG_CONFIG_HOME: join(stateRoot, 'edge/config'),
        XDG_DATA_HOME: join(stateRoot, 'edge/data'),
      },
      healthUrl: supplied.OPENLINK_APP_URL,
    },
  ]
  const zeroImages = profile.components.zero ? await imageEntries(releaseRoot, 'zero') : []
  const stateDirectories = ['workspaces', 'agents', 'desktop-agents', 'browser', 'project-vms', 'podman/config', 'podman/data', 'edge/config', 'edge/data', 'zokerbase', ...(profile.components.knowledge ? ['knowledge'] : []), ...(profile.components.zero ? ['zero'] : [])]
  return {
    releaseRoot,
    stateRoot,
    profile: profile.name,
    profileRevision: profile.revision,
    projectRuntime,
    isolationClass: isolationClass(projectRuntime),
    docker,
    containerBrokerSocket: supplied.OPENLINK_CONTAINER_BROKER_SOCKET,
    images: [...runtimeImages, ...await imageEntries(releaseRoot, 'zokerbase'), ...zeroImages],
    compose,
    processes,
    stateDirectories,
  }
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
    return response.status >= 200 && response.status < 300
  } catch { return false }
}

export async function checkContainerRuntime(plan, runCommand = defaultCommand) {
  await runCommand(plan.docker, ['info', '--format', 'json'])
  await runCommand(plan.docker, ['compose', 'version', '--short'])
  return { ready: true }
}

export async function startContainerRuntime(plan, runCommand = defaultCommand) {
  for (const item of plan.images) {
    await access(item.archive, constants.R_OK)
    const inspect = async () => (await runCommand(plan.docker, ['image', 'inspect', '--format', '{{.Id}}', item.image])).trim()
    const installedId = await inspect().catch(() => '')
    if (installedId !== item.imageId) {
      await runCommand(plan.docker, ['load', '--input', item.archive], { stdio: 'inherit' })
      const loadedId = await inspect().catch(() => '')
      if (loadedId !== item.imageId) throw new Error(`Loaded image identity does not match the signed manifest: ${item.image}`)
    }
  }
  for (const item of plan.compose) await runCommand(item.command, item.args, item)
  return { started: true }
}

export async function stopContainerRuntime(plan, runCommand = defaultCommand) {
  const failures = []
  for (const item of [...plan.compose].reverse()) {
    await runCommand(item.command, item.stopArgs, item).catch((error) => failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`))
  }
  if (failures.length) throw new Error(`Container runtime shutdown failed: ${failures.join('; ')}`)
  return { stopped: true }
}

export class ProductionSupervisor {
  constructor(plan, dependencies = {}) {
    this.plan = plan
    this.runCommand = dependencies.runCommand ?? defaultCommand
    this.spawnProcess = dependencies.spawnProcess ?? ((command, args, options) => spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? 'inherit' }))
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
    for (const directory of this.plan.stateDirectories) {
      await mkdir(join(this.plan.stateRoot, directory), { recursive: true, mode: 0o700 })
    }
    if (this.plan.containerBrokerSocket) await requestContainerBroker(this.plan.containerBrokerSocket, 'start')
    else await startContainerRuntime(this.plan, this.runCommand)
    for (const item of this.plan.processes) {
      const invocation = isolatedProcessInvocation(item)
      const child = this.spawnProcess(invocation.command, invocation.args, { cwd: item.cwd, env: childEnvironment(item.environment), stdio: item.stdio, openlinkName: item.name, productionIdentity: item.identity })
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
    if (this.plan.containerBrokerSocket) await requestContainerBroker(this.plan.containerBrokerSocket, 'stop').catch(() => undefined)
    else await stopContainerRuntime(this.plan, this.runCommand)
  }
}
