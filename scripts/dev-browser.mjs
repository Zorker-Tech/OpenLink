import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureZokerbase } from './zokerbase.mjs'

const root = new URL('../', import.meta.url)
const browserHostDirectory = new URL('../services/browser-host/', import.meta.url)
const agentHostDirectory = new URL('../services/agent-host/', import.meta.url)
const agentWorkerDirectory = new URL('../services/agent-worker/', import.meta.url)
const agentRpcWorkerDirectory = new URL('../services/agent-rpc-worker/', import.meta.url)
const sandboxRuntimeDirectory = new URL('../services/sandbox-runtime/', import.meta.url)
const providerSecretPath = fileURLToPath(new URL('../.openlink-runtime/provider-secret.key', import.meta.url))
const podmanCommand = fileURLToPath(new URL('../.openlink-runtime/toolchain/bin/podman', import.meta.url))
const podmanHelperBinariesDir = fileURLToPath(new URL('../.openlink-runtime/toolchain/bin/', import.meta.url))
const podmanConfigRoot = fileURLToPath(new URL('../.openlink-runtime/podman-config/', import.meta.url))
// Podman defaults its machine disks to the macOS system volume under $HOME.
// OpenLink's repository can live on a separate data volume, so keep every
// mutable machine disk together with the rest of the product runtime. This
// also makes a Project VM genuinely owned by OpenLink rather than by a
// developer's global Podman installation.
const podmanDataRoot = fileURLToPath(new URL('../.openlink-runtime/podman-data/', import.meta.url))
const projectVmStateRoot = fileURLToPath(new URL('../.openlink-runtime/project-vms', import.meta.url))
const projectImageRoot = fileURLToPath(new URL('../.openlink-runtime/images/', import.meta.url))
const projectVmBaseRoot = fileURLToPath(new URL('../.openlink-runtime/project-vm-base/', import.meta.url))
const projectVmBaseManifestPath = `${projectVmBaseRoot}/manifest.json`
const apiToken = process.env.OPENLINK_BROWSER_API_TOKEN || randomBytes(48).toString('base64url')
const tokenSecret = process.env.OPENLINK_BROWSER_TOKEN_SECRET || randomBytes(48).toString('base64url')
const agentApiToken = process.env.OPENLINK_AGENT_API_TOKEN || randomBytes(48).toString('base64url')
const desktopAgentApiToken = process.env.OPENLINK_DESKTOP_AGENT_API_TOKEN || randomBytes(48).toString('base64url')
const openSandboxApiToken = process.env.OPEN_SANDBOX_API_KEY || randomBytes(48).toString('base64url')
const hostUrl = process.env.OPENLINK_BROWSER_HOST_URL || 'http://127.0.0.1:43120'
const agentHostUrl = process.env.OPENLINK_AGENT_HOST_URL || 'http://127.0.0.1:43121'
const desktopAgentHostUrl = process.env.OPENLINK_DESKTOP_AGENT_HOST_URL || 'http://127.0.0.1:43123'

function localPublicAgentGatewayUrl() {
  // The Agent Host may bind to 127.0.0.1 while the browser reaches OpenLink
  // at localhost (or the inverse). Those are different schemeful sites, so
  // an iframe cannot return the gateway's SameSite cookie after bootstrap.
  // Keep the public gateway host aligned with the app's explicit local URL;
  // production deployments supply their own authenticated public gateway.
  const configured = process.env.OPENLINK_BROWSER_GATEWAY_PUBLIC_URL || process.env.OPENLINK_AGENT_PUBLIC_URL
  if (configured) return configured
  const gateway = new URL(agentHostUrl)
  const appUrl = process.env.OPENLINK_APP_URL
  if (appUrl) {
    try {
      const app = new URL(appUrl)
      if (['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)) gateway.hostname = app.hostname
    } catch {
      // The configured app URL is independently validated by the web app.
    }
  } else if (gateway.hostname === '127.0.0.1' || gateway.hostname === '[::1]') {
    gateway.hostname = 'localhost'
  }
  return gateway.toString().replace(/\/$/, '')
}

const agentGatewayPublicUrl = localPublicAgentGatewayUrl()
// `localhost` and `127.0.0.1` are different schemeful sites. Both are first-
// class Local URLs, so accept both for Browser and code-server iframe gateways.
const localAllowedOrigins = process.env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000'

function lifecycleMode(argv) {
  const modeIndex = argv.indexOf('--mode')
  const mode = modeIndex === -1 ? 'development' : argv[modeIndex + 1]
  if (mode !== 'development' && mode !== 'production') {
    throw new Error('OpenLink lifecycle mode must be development or production')
  }
  return mode
}

const mode = lifecycleMode(process.argv.slice(2))
const runtimeMode = (process.env.OPENLINK_RUNTIME_MODE ?? 'local').trim().toLowerCase()
if (runtimeMode !== 'local' && runtimeMode !== 'cloud') throw new Error('OPENLINK_RUNTIME_MODE must be either local or cloud')
let projectVmBase

async function loadProjectVmBase() {
  let manifest
  try {
    manifest = JSON.parse(await readFile(projectVmBaseManifestPath, 'utf8'))
  } catch {
    throw new Error('OpenLink Project VM image manifest is missing. Run `OPENLINK_BUILD_ARTIFACTS=1 pnpm start` during image production.')
  }
  const disk = typeof manifest.disk === 'string' && manifest.disk.trim() ? manifest.disk.trim() : ''
  if (!disk || typeof manifest.fingerprint !== 'string' || !manifest.fingerprint) {
    throw new Error('OpenLink Project VM image manifest does not contain a bootable local disk image')
  }
  const diskPath = resolve(projectVmBaseRoot, disk)
  try {
    await access(diskPath, constants.R_OK)
  } catch {
    throw new Error(`OpenLink Project VM disk image is missing: ${diskPath}`)
  }
  return { fingerprint: manifest.fingerprint, disk, diskPath }
}

async function persistentProviderSecret() {
  if (process.env.OPENLINK_PROVIDER_SECRET_KEY) {
    try {
      const existing = (await readFile(providerSecretPath, 'utf8')).trim()
      if (existing) return existing
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await mkdir(dirname(providerSecretPath), { recursive: true, mode: 0o700 })
    await writeFile(providerSecretPath, `${process.env.OPENLINK_PROVIDER_SECRET_KEY}\n`, { mode: 0o600, flag: 'wx' }).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error
    })
    return (await readFile(providerSecretPath, 'utf8')).trim()
  }
  try {
    const existing = (await readFile(providerSecretPath, 'utf8')).trim()
    if (existing) return existing
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(providerSecretPath), { recursive: true, mode: 0o700 })
  const secret = randomBytes(32).toString('base64')
  await writeFile(providerSecretPath, `${secret}\n`, { mode: 0o600, flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error
  })
  return (await readFile(providerSecretPath, 'utf8')).trim()
}

function enforceIsolatedMachineVolumes(contents) {
  const output = []
  let inMachine = false
  let foundMachine = false
  let wroteVolumes = false
  for (const line of contents.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1]
    if (section) {
      if (inMachine && !wroteVolumes) output.push('volumes = []')
      inMachine = section === 'machine'
      if (inMachine) foundMachine = true
      output.push(line)
      continue
    }
    if (inMachine && /^\s*volumes\s*=/.test(line)) {
      if (!wroteVolumes) output.push('volumes = []')
      wroteVolumes = true
      continue
    }
    output.push(line)
  }
  if (inMachine && !wroteVolumes) output.push('volumes = []')
  if (!foundMachine) output.push('[machine]', 'volumes = []')
  return `${output.join('\n').trim()}\n`
}

async function ensurePodmanConfig() {
  // Keep the machine client configuration inside OpenLink's runtime instead
  // of mutating the user's global Podman configuration. Project VMs must not
  // inherit Podman's macOS defaults (/Users, /private, /var/folders); their
  // only durable filesystem is the Project-owned virtual disk.
  const containersDirectory = `${podmanConfigRoot}/containers`
  await mkdir(podmanDataRoot, { recursive: true, mode: 0o700 })
  await mkdir(containersDirectory, { recursive: true, mode: 0o700 })
  const policyPath = `${containersDirectory}/policy.json`
  try {
    const existing = (await readFile(policyPath, 'utf8')).trim()
    if (!existing) await writeFile(policyPath, '{"default":[{"type":"insecureAcceptAnything"}]}\n', { mode: 0o600 })
  } catch (error) {
    if (error?.code === 'ENOENT') await writeFile(policyPath, '{"default":[{"type":"insecureAcceptAnything"}]}\n', { mode: 0o600 })
    else throw error
  }
  const configPath = `${containersDirectory}/containers.conf`
  const helperConfig = `[engine]\nhelper_binaries_dir = ["${podmanHelperBinariesDir}"]\n`
  try {
    let existing = await readFile(configPath, 'utf8')
    let next = existing
    if (!next.includes('helper_binaries_dir')) next = `${next.trimEnd()}\n${helperConfig}`
    next = enforceIsolatedMachineVolumes(next)
    if (next !== existing) await writeFile(configPath, `${next.trimEnd()}\n`, { mode: 0o600 })
  } catch (error) {
    if (error?.code === 'ENOENT') await writeFile(configPath, enforceIsolatedMachineVolumes(helperConfig), { mode: 0o600 })
    else throw error
  }
}

async function executable(candidates) {
  if (process.env.OPENLINK_CHROME_EXECUTABLE) return process.env.OPENLINK_CHROME_EXECUTABLE
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error('No Chromium-family executable found. Set OPENLINK_CHROME_EXECUTABLE.')
}

function run(command, args, options = {}) {
  return spawn(command, args, { shell: false, stdio: 'inherit', ...options })
}

async function waitForExit(child, label) {
  const code = await new Promise((resolve) => child.once('exit', resolve))
  if (code !== 0) throw new Error(`${label} exited with code ${code ?? 1}`)
}

async function ensureNpmDependencies(name, directory, extraInputs = []) {
  const markerRoot = fileURLToPath(new URL('../.openlink-runtime/service-dependencies/', import.meta.url))
  const packageJson = await readFile(new URL('package.json', directory))
  const packageLock = await readFile(new URL('package-lock.json', directory))
  const fingerprint = createHash('sha256')
    .update(packageJson)
    .update(packageLock)
    .update(process.versions.node)
  for (const input of extraInputs) fingerprint.update(await readFile(input))
  const dependencyFingerprint = fingerprint.digest('hex')
  const markerPath = `${markerRoot}/${name}.json`
  const nodeModulesPath = fileURLToPath(new URL('node_modules/', directory))
  let current = false
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    await access(nodeModulesPath, constants.F_OK)
    current = marker.fingerprint === dependencyFingerprint
  } catch {}
  if (current) return

  // Service dependencies are part of the OpenLink lifecycle.  A dropped
  // registry connection must not leave a half-installed service that looks
  // current on the next startup, so use npm's deterministic lockfile install
  // with bounded transport retries and write the marker only after success.
  const install = run('npm', [
    'ci',
    '--ignore-scripts',
    '--fetch-retries=5',
    '--fetch-retry-factor=2',
    '--fetch-retry-mintimeout=20000',
    '--fetch-retry-maxtimeout=120000',
  ], {
    cwd: directory,
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '1',
      npm_config_registry: process.env.OPENLINK_NPM_REGISTRY || 'https://registry.npmjs.org',
    },
  })
  await waitForExit(install, `${name} dependency installation`)
  await mkdir(markerRoot, { recursive: true, mode: 0o700 })
  await writeFile(markerPath, `${JSON.stringify({ fingerprint: dependencyFingerprint, node: process.version, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
}

async function waitForHealth(url, child, name, path = '/healthz') {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`${url}${path}`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${name} did not become healthy within 120 seconds`)
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  const candidates = [
    process.env.OPENLINK_NODE_EXECUTABLE,
    `${process.env.HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`,
    '/opt/homebrew/bin/node',
  ].filter(Boolean)
  let replacement
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      replacement = candidate
      break
    } catch {}
  }
  if (!replacement) throw new Error('Local Agent development requires Node 22.19 or newer. Set OPENLINK_NODE_EXECUTABLE.')
  const child = run(replacement, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, PATH: `${dirname(replacement)}:${process.env.PATH || ''}` },
  })
  process.exit(await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code ?? 1))))
}
const providerSecret = await persistentProviderSecret()
await ensurePodmanConfig()
const localZokerbase = runtimeMode === 'local' ? await ensureZokerbase() : null

const chromeExecutable = await executable([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
])

if (process.env.OPENLINK_BUILD_ARTIFACTS === '1') {
  const podmanBuild = run(process.execPath, ['scripts/ensure-podman-toolchain.mjs'], { cwd: root })
  await waitForExit(podmanBuild, 'Podman toolchain build')

  await ensureNpmDependencies('pi', new URL('../services/pi/', import.meta.url))

  const piSync = run(process.execPath, ['scripts/sync-pi-runtime.mjs'], { cwd: root })
  await waitForExit(piSync, 'Pi runtime sync')

  await ensureNpmDependencies('sandbox-runtime', sandboxRuntimeDirectory)
  await ensureNpmDependencies('browser-host', browserHostDirectory)
  await ensureNpmDependencies('agent-host', agentHostDirectory)
  const piRuntimeManifest = new URL('../packages/pi-runtime/manifest.json', import.meta.url)
  await ensureNpmDependencies('agent-worker', agentWorkerDirectory, [piRuntimeManifest])
  await ensureNpmDependencies('agent-rpc-worker', agentRpcWorkerDirectory, [piRuntimeManifest])

  const build = run('npm', ['run', 'build'], { cwd: browserHostDirectory })
  await waitForExit(build, 'Browser Host build')
  const sandboxRuntimeBuild = run('npm', ['run', 'build'], { cwd: sandboxRuntimeDirectory })
  await waitForExit(sandboxRuntimeBuild, 'Sandbox Runtime build')
  const agentBuild = run('npm', ['run', 'build'], { cwd: agentHostDirectory })
  await waitForExit(agentBuild, 'Agent Host build')
  const workerBuild = run('npm', ['run', 'build'], { cwd: agentWorkerDirectory })
  await waitForExit(workerBuild, 'Agent Worker build')
  const rpcWorkerBuild = run('npm', ['run', 'build'], { cwd: agentRpcWorkerDirectory })
  await waitForExit(rpcWorkerBuild, 'Agent RPC Worker build')
  const projectVmBaseBuild = run(process.execPath, ['scripts/build-project-vm-base.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      OPENLINK_PODMAN_COMMAND: podmanCommand,
      XDG_CONFIG_HOME: podmanConfigRoot,
      XDG_DATA_HOME: podmanDataRoot,
      CONTAINERS_HELPER_BINARY_DIR: podmanHelperBinariesDir,
      OPENLINK_STOP_ACTIVE_MACHINES: '1',
      CONTAINERS_MACHINE_PROVIDER: process.env.CONTAINERS_MACHINE_PROVIDER || 'applehv',
      PATH: `${podmanHelperBinariesDir}:${process.env.PATH || ''}`,
    },
  })
  await waitForExit(projectVmBaseBuild, 'Project VM base image build')
  const projectVmDiskBuild = run(process.execPath, ['scripts/build-project-vm-disk.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      OPENLINK_PODMAN_COMMAND: podmanCommand,
      XDG_CONFIG_HOME: podmanConfigRoot,
      XDG_DATA_HOME: podmanDataRoot,
      CONTAINERS_HELPER_BINARY_DIR: podmanHelperBinariesDir,
      CONTAINERS_MACHINE_PROVIDER: process.env.CONTAINERS_MACHINE_PROVIDER || 'applehv',
      PATH: `${podmanHelperBinariesDir}:${process.env.PATH || ''}`,
    },
  })
  await waitForExit(projectVmDiskBuild, 'Project VM disk image build')
  const projectImagesBuild = run(process.execPath, ['scripts/build-project-runtime-images.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      OPENLINK_PODMAN_COMMAND: podmanCommand,
      XDG_CONFIG_HOME: podmanConfigRoot,
      XDG_DATA_HOME: podmanDataRoot,
      CONTAINERS_HELPER_BINARY_DIR: podmanHelperBinariesDir,
      OPENLINK_STOP_ACTIVE_MACHINES: '1',
      CONTAINERS_MACHINE_PROVIDER: process.env.CONTAINERS_MACHINE_PROVIDER || 'applehv',
      PATH: `${podmanHelperBinariesDir}:${process.env.PATH || ''}`,
    },
  })
  await waitForExit(projectImagesBuild, 'Project runtime image build')

  if (mode === 'production') {
    const webBuild = run('pnpm', ['build:web'], { cwd: root })
    await waitForExit(webBuild, 'OpenLink web production build')
  }
}

projectVmBase = await loadProjectVmBase()

const shared = {
  ...process.env,
  OPENLINK_RUNTIME_MODE: runtimeMode,
  NEXT_PUBLIC_OPENLINK_RUNTIME_MODE: runtimeMode,
  ...(localZokerbase ? {
    OPENLINK_LOCAL_ZOKERBASE_URL: localZokerbase.url,
    OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY: localZokerbase.publishableKey,
    OPENLINK_LOCAL_ZOKERBASE_SECRET_KEY: localZokerbase.secretKey,
    OPENLINK_LOCAL_ZOKERBASE_DATABASE_URL: localZokerbase.databaseUrl,
    // Compatibility aliases for the existing Supabase API client layer.
    OPENLINK_LOCAL_SUPABASE_URL: localZokerbase.url,
    OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY: localZokerbase.publishableKey,
    OPENLINK_LOCAL_SUPABASE_SECRET_KEY: localZokerbase.secretKey,
    OPENLINK_LOCAL_DATABASE_URL: localZokerbase.databaseUrl,
    // Local is a complete independent identity and data domain. Never inject
    // Cloud URL, JWT material, or client keys into this process.
    NEXT_PUBLIC_SUPABASE_URL: localZokerbase.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: localZokerbase.publishableKey,
  } : {}),
  OPENLINK_BROWSER_API_TOKEN: apiToken,
  OPENLINK_BROWSER_TOKEN_SECRET: tokenSecret,
  OPENLINK_BROWSER_ALLOWED_ORIGINS: localAllowedOrigins,
  // The local dev preview commonly runs on localhost/127.0.0.1. Keep this
  // default scoped to the dev orchestrator; deployed Browser Hosts still
  // require the explicit server-side policy setting.
  OPENLINK_BROWSER_ALLOW_LOOPBACK: process.env.OPENLINK_BROWSER_ALLOW_LOOPBACK || 'true',
  OPENLINK_BROWSER_HOST: '127.0.0.1',
  OPENLINK_BROWSER_PORT: new URL(hostUrl).port || '43120',
  OPENLINK_BROWSER_PUBLIC_URL: hostUrl,
  OPENLINK_BROWSER_HOST_URL: hostUrl,
  OPENLINK_CHROME_EXECUTABLE: chromeExecutable,
  OPENLINK_AGENT_API_TOKEN: agentApiToken,
  OPENLINK_PROVIDER_SECRET_KEY: providerSecret,
  OPENLINK_DESKTOP_AGENT_API_TOKEN: desktopAgentApiToken,
  OPENLINK_AGENT_HOST_URL: agentHostUrl,
  // Browser/code-editor URLs must be same-site with the web application so
  // their HttpOnly gateway cookies work inside sandboxed iframes. Remote
  // deployments provide their authenticated HTTPS gateway explicitly.
  OPENLINK_BROWSER_GATEWAY_PUBLIC_URL: agentGatewayPublicUrl,
  OPENLINK_AGENT_PUBLIC_URL: agentGatewayPublicUrl,
  OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS: process.env.OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS || localAllowedOrigins,
  OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN: process.env.OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN || 'http://localhost:3000',
  OPENLINK_DESKTOP_AGENT_HOST_URL: desktopAgentHostUrl,
  OPENLINK_AGENT_HOST: '127.0.0.1',
  OPENLINK_AGENT_PORT: new URL(agentHostUrl).port || '43121',
  OPENLINK_DESKTOP_AGENT_HOST: '127.0.0.1',
  OPENLINK_DESKTOP_AGENT_PORT: new URL(desktopAgentHostUrl).port || '43123',
  OPENLINK_NODE_EXECUTABLE: process.execPath,
  OPENLINK_AGENT_WORKSPACE_ROOT: fileURLToPath(root),
  OPENLINK_AGENT_STORAGE_ROOT: fileURLToPath(new URL('../.agent-data/', import.meta.url)),
  OPENLINK_AGENT_WORKER_IMAGE: 'openlink/agent-worker:dev',
  OPENLINK_AGENT_RPC_WORKER_IMAGE: 'openlink/agent-rpc-worker:dev',
  OPENLINK_BROWSER_HOST_IMAGE: 'openlink/browser-host:dev',
  OPENLINK_CODE_SERVER_IMAGE: 'openlink/code-server:dev',
  OPENLINK_OPENSANDBOX_SERVER_IMAGE: 'openlink/opensandbox-server:dev',
  OPENLINK_OPENSANDBOX_EXECD_IMAGE: 'openlink/opensandbox-execd:dev',
  OPENLINK_OPENSANDBOX_EGRESS_IMAGE: 'openlink/opensandbox-egress:dev',
  OPENLINK_PODMAN_COMMAND: podmanCommand,
  OPENLINK_PODMAN_HELPER_BINARIES_DIR: podmanHelperBinariesDir,
  CONTAINERS_HELPER_BINARY_DIR: podmanHelperBinariesDir,
  XDG_CONFIG_HOME: podmanConfigRoot,
  XDG_DATA_HOME: podmanDataRoot,
  // AppleHV uses the bundled vfkit + gvproxy artifacts and does not require
  // a system krunkit/libkrun installation on macOS.
  CONTAINERS_MACHINE_PROVIDER: process.env.CONTAINERS_MACHINE_PROVIDER || 'applehv',
  OPENLINK_PROJECT_VM_STATE_ROOT: projectVmStateRoot,
  OPENLINK_PROJECT_VM_BASE_DISK: projectVmBase.diskPath,
  OPENLINK_PROJECT_VM_BOOTSTRAP: '1',
  // Rootful here is inside the isolated Project VM, not on the macOS host.
  // OpenSandbox's egress/Credential Vault sidecar requires NET_ADMIN; keep the
  // unsafe rootless credential path opt-in and explicit for development.
  OPENLINK_PROJECT_VM_ROOTFUL: process.env.OPENLINK_PROJECT_VM_ROOTFUL || '1',
  OPENLINK_ALLOW_UNSAFE_ROOTLESS_PROVIDER_CREDENTIALS: process.env.OPENLINK_ALLOW_UNSAFE_ROOTLESS_PROVIDER_CREDENTIALS || '0',
  OPENLINK_PROJECT_RUNTIME_IMAGE_ARCHIVES: JSON.stringify({
    'openlink/agent-worker:dev': `${projectImageRoot}/openlink_agent-worker_dev.tar`,
    'openlink/agent-rpc-worker:dev': `${projectImageRoot}/openlink_agent-rpc-worker_dev.tar`,
    'openlink/browser-host:dev': `${projectImageRoot}/openlink_browser-host_dev.tar`,
    'openlink/code-server:dev': `${projectImageRoot}/openlink_code-server_dev.tar`,
    'openlink/opensandbox-server:dev': `${projectImageRoot}/openlink_opensandbox-server_dev.tar`,
    'openlink/opensandbox-execd:dev': `${projectImageRoot}/openlink_opensandbox-execd_dev.tar`,
    'openlink/opensandbox-egress:dev': `${projectImageRoot}/openlink_opensandbox-egress_dev.tar`,
  }),
  // Optional privileged projection writer. The service-role key is never
  // exposed to the browser or forwarded to a worker; it is consumed only by
  // Agent Host's project_runtimes status updater.
  ...(localZokerbase || process.env.OPENLINK_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    ? { OPENLINK_SUPABASE_URL: localZokerbase?.url || process.env.OPENLINK_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL }
    : {}),
  ...(localZokerbase?.secretKey || process.env.OPENLINK_SUPABASE_SERVICE_ROLE_KEY
    ? { OPENLINK_SUPABASE_SERVICE_ROLE_KEY: localZokerbase?.secretKey || process.env.OPENLINK_SUPABASE_SERVICE_ROLE_KEY }
    : {}),
  // Kept as constructor configuration for the project-scoped backend; no
  // process-global OpenSandbox is started by this orchestrator.
  OPEN_SANDBOX_DOMAIN: process.env.OPEN_SANDBOX_DOMAIN || '127.0.0.1:43122',
  OPEN_SANDBOX_API_KEY: openSandboxApiToken,
  OPENSANDBOX_SERVER_API_KEY: openSandboxApiToken,
}

const browserHost = run(process.execPath, ['dist/src/main.js'], { cwd: browserHostDirectory, env: shared })
await waitForHealth(hostUrl, browserHost, 'Browser Host')
const agentHost = run(process.execPath, ['dist/src/main.js'], { cwd: agentHostDirectory, env: shared })
await waitForHealth(agentHostUrl, agentHost, 'Agent Host')
const desktopAgentHost = run(process.execPath, ['dist/src/desktop-main.js'], { cwd: agentHostDirectory, env: shared })
await waitForHealth(desktopAgentHostUrl, desktopAgentHost, 'Desktop Agent Host')
const next = run('pnpm', [mode === 'production' ? 'start:web' : 'dev:web'], { cwd: root, env: shared })

let shuttingDown = false
async function stop(child, signal, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  // Keep the dependency order explicit. Agent Host owns Project VM,
  // OpenSandbox and browser-session cleanup; killing Browser Host alongside
  // it can make those DELETEs fail. The previous 10-second parallel shutdown
  // also routinely SIGKILLed a host while a VM was still being stopped.
  await stop(next, signal, 15_000).catch(() => undefined)
  await stop(desktopAgentHost, signal, 30_000).catch(() => undefined)
  await stop(agentHost, signal, 120_000).catch(() => undefined)
  await stop(browserHost, signal, 30_000).catch(() => undefined)
}

process.once('SIGINT', () => { void shutdown('SIGINT').finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void shutdown('SIGTERM').finally(() => process.exit(0)) })
next.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 0))
})
agentHost.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 1))
})
desktopAgentHost.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 1))
})
browserHost.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 1))
})
