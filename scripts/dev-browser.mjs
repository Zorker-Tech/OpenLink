import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const browserHostDirectory = new URL('../services/browser-host/', import.meta.url)
const agentHostDirectory = new URL('../services/agent-host/', import.meta.url)
const agentWorkerDirectory = new URL('../services/agent-worker/', import.meta.url)
const agentRpcWorkerDirectory = new URL('../services/agent-rpc-worker/', import.meta.url)
const sandboxRuntimeDirectory = new URL('../services/sandbox-runtime/', import.meta.url)
const openSandboxDirectory = new URL('../services/opensandbox/server/', import.meta.url)
const openSandboxConfig = fileURLToPath(new URL('../.openlink-runtime/opensandbox.toml', import.meta.url))
const providerSecretPath = fileURLToPath(new URL('../.openlink-runtime/provider-secret.key', import.meta.url))
const apiToken = process.env.OPENLINK_BROWSER_API_TOKEN || randomBytes(48).toString('base64url')
const tokenSecret = process.env.OPENLINK_BROWSER_TOKEN_SECRET || randomBytes(48).toString('base64url')
const agentApiToken = process.env.OPENLINK_AGENT_API_TOKEN || randomBytes(48).toString('base64url')
const desktopAgentApiToken = process.env.OPENLINK_DESKTOP_AGENT_API_TOKEN || randomBytes(48).toString('base64url')
const openSandboxApiToken = process.env.OPEN_SANDBOX_API_KEY || randomBytes(48).toString('base64url')
const hostUrl = process.env.OPENLINK_BROWSER_HOST_URL || 'http://127.0.0.1:43120'
const agentHostUrl = process.env.OPENLINK_AGENT_HOST_URL || 'http://127.0.0.1:43121'
const desktopAgentHostUrl = process.env.OPENLINK_DESKTOP_AGENT_HOST_URL || 'http://127.0.0.1:43123'
const openSandboxUrl = process.env.OPENLINK_OPENSANDBOX_URL || 'http://127.0.0.1:43122'

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
  const child = run(replacement, [fileURLToPath(import.meta.url)], {
    cwd: root,
    env: { ...process.env, PATH: `${dirname(replacement)}:${process.env.PATH || ''}` },
  })
  process.exit(await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code ?? 1))))
}
await access(openSandboxConfig, constants.R_OK)
const providerSecret = await persistentProviderSecret()

const chromeExecutable = await executable([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
])

if (process.env.OPENLINK_SKIP_LOCAL_BUILDS !== '1') {
  const piSync = run(process.execPath, ['scripts/sync-pi-runtime.mjs'], { cwd: root })
  const piSyncCode = await new Promise((resolve) => piSync.once('exit', resolve))
  if (piSyncCode !== 0) process.exit(piSyncCode ?? 1)

  const build = run('npm', ['run', 'build'], { cwd: browserHostDirectory })
  const buildCode = await new Promise((resolve) => build.once('exit', resolve))
  if (buildCode !== 0) process.exit(buildCode ?? 1)
  const sandboxRuntimeBuild = run('npm', ['run', 'build'], { cwd: sandboxRuntimeDirectory })
  const sandboxRuntimeBuildCode = await new Promise((resolve) => sandboxRuntimeBuild.once('exit', resolve))
  if (sandboxRuntimeBuildCode !== 0) process.exit(sandboxRuntimeBuildCode ?? 1)
  const agentBuild = run('npm', ['run', 'build'], { cwd: agentHostDirectory })
  const agentBuildCode = await new Promise((resolve) => agentBuild.once('exit', resolve))
  if (agentBuildCode !== 0) process.exit(agentBuildCode ?? 1)
  const workerBuild = run('npm', ['run', 'build'], { cwd: agentWorkerDirectory })
  const workerBuildCode = await new Promise((resolve) => workerBuild.once('exit', resolve))
  if (workerBuildCode !== 0) process.exit(workerBuildCode ?? 1)
  const imageBuild = run('docker', ['build', '-f', 'services/agent-worker/Dockerfile', '-t', 'openlink/agent-worker:dev', '.'], { cwd: root })
  const imageBuildCode = await new Promise((resolve) => imageBuild.once('exit', resolve))
  if (imageBuildCode !== 0) process.exit(imageBuildCode ?? 1)
  const rpcWorkerBuild = run('npm', ['run', 'build'], { cwd: agentRpcWorkerDirectory })
  const rpcWorkerBuildCode = await new Promise((resolve) => rpcWorkerBuild.once('exit', resolve))
  if (rpcWorkerBuildCode !== 0) process.exit(rpcWorkerBuildCode ?? 1)
  const rpcImageBuild = run('docker', ['build', '-f', 'services/agent-rpc-worker/Dockerfile', '-t', 'openlink/agent-rpc-worker:dev', '.'], { cwd: root })
  const rpcImageBuildCode = await new Promise((resolve) => rpcImageBuild.once('exit', resolve))
  if (rpcImageBuildCode !== 0) process.exit(rpcImageBuildCode ?? 1)
  const execdImageBuild = run('docker', ['build', '-f', 'components/execd/Dockerfile', '-t', 'openlink/opensandbox-execd:dev', '.'], { cwd: new URL('../services/opensandbox/', import.meta.url) })
  const execdImageBuildCode = await new Promise((resolve) => execdImageBuild.once('exit', resolve))
  if (execdImageBuildCode !== 0) process.exit(execdImageBuildCode ?? 1)
  const egressImageBuild = run('docker', ['build', '-f', 'components/egress/Dockerfile', '-t', 'openlink/opensandbox-egress:dev', '.'], { cwd: new URL('../services/opensandbox/', import.meta.url) })
  const egressImageBuildCode = await new Promise((resolve) => egressImageBuild.once('exit', resolve))
  if (egressImageBuildCode !== 0) process.exit(egressImageBuildCode ?? 1)
}

const shared = {
  ...process.env,
  OPENLINK_BROWSER_API_TOKEN: apiToken,
  OPENLINK_BROWSER_TOKEN_SECRET: tokenSecret,
  OPENLINK_BROWSER_ALLOWED_ORIGINS: process.env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000',
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
  OPENLINK_DESKTOP_AGENT_HOST_URL: desktopAgentHostUrl,
  OPENLINK_AGENT_HOST: '127.0.0.1',
  OPENLINK_AGENT_PORT: new URL(agentHostUrl).port || '43121',
  OPENLINK_DESKTOP_AGENT_HOST: '127.0.0.1',
  OPENLINK_DESKTOP_AGENT_PORT: new URL(desktopAgentHostUrl).port || '43123',
  OPENLINK_NODE_EXECUTABLE: process.execPath,
  OPENLINK_AGENT_WORKSPACE_ROOT: fileURLToPath(root),
  OPENLINK_AGENT_STORAGE_ROOT: fileURLToPath(new URL('../.agent-data/', import.meta.url)),
  OPENLINK_AGENT_WORKER_IMAGE: 'openlink/agent-worker:dev',
  OPEN_SANDBOX_DOMAIN: new URL(openSandboxUrl).host,
  OPEN_SANDBOX_API_KEY: openSandboxApiToken,
  OPENSANDBOX_SERVER_API_KEY: openSandboxApiToken,
}

const openSandbox = run('uv', ['run', '--directory', fileURLToPath(openSandboxDirectory), 'opensandbox-server', '--config', openSandboxConfig], { cwd: root, env: shared })
await waitForHealth(openSandboxUrl, openSandbox, 'OpenSandbox', '/health')
const browserHost = run('npm', ['start'], { cwd: browserHostDirectory, env: shared })
await waitForHealth(hostUrl, browserHost, 'Browser Host')
const agentHost = run(process.execPath, ['dist/src/main.js'], { cwd: agentHostDirectory, env: shared })
await waitForHealth(agentHostUrl, agentHost, 'Agent Host')
const desktopAgentHost = run(process.execPath, ['dist/src/desktop-main.js'], { cwd: agentHostDirectory, env: shared })
await waitForHealth(desktopAgentHostUrl, desktopAgentHost, 'Desktop Agent Host')
const next = run('pnpm', ['dev'], { cwd: root, env: shared })

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
  await Promise.allSettled([
    stop(next, signal),
    stop(browserHost, signal),
    stop(desktopAgentHost, signal),
    // Agent Host must delete active OpenSandbox workloads before the control
    // plane itself is stopped.
    stop(agentHost, signal),
  ])
  await stop(openSandbox, signal)
}

process.once('SIGINT', () => { void shutdown('SIGINT').finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void shutdown('SIGTERM').finally(() => process.exit(0)) })
next.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 0))
})
browserHost.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 1))
})
agentHost.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 1))
})
desktopAgentHost.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 1))
})
openSandbox.once('exit', (code) => {
  if (!shuttingDown) void shutdown('SIGTERM').finally(() => process.exit(code ?? 1))
})
