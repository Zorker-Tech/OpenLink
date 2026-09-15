import { execFile as execFileCallback, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { resolveHostPlatform } from './host-platform.mjs'

const execFile = promisify(execFileCallback)
let resolvedDockerCommand

function exposeDockerCompanionTools(command, host, env) {
  if (host.platform !== 'win32' || !command.includes('\\')) return
  const directory = dirname(command)
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path'
  const entries = String(env[pathKey] || '').split(host.pathDelimiter).filter(Boolean)
  if (!entries.some((entry) => entry.toLowerCase() === directory.toLowerCase())) {
    env[pathKey] = [directory, ...entries].join(host.pathDelimiter)
  }
}

// CLI discovery must not depend on the daemon. Docker Desktop may be stopped
// on a clean login, which is exactly when ensureDockerEngine needs to find the
// client and launch it.
async function commandWorks(command, args = ['--version']) {
  try {
    await execFile(command, args, { shell: false, windowsHide: true, timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

export function isDockerServerVersion(output) {
  const value = String(output).trim().replace(/^"|"$/g, '')
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
}

async function engineWorks(command) {
  // OPENLINK_DOCKER_COMMAND deliberately accepts Docker-compatible engines.
  // Docker exposes its daemon version at .ServerVersion while Podman exposes
  // the remote engine version at .Version.Version, so probe both schemas.
  // Keep the validation strict: Docker Desktop can return exit code 0 while
  // printing an error message when its VM failed to start.
  for (const template of ['{{json .ServerVersion}}', '{{json .Version.Version}}']) {
    try {
      const { stdout } = await execFile(command, ['info', '--format', template], {
        shell: false,
        windowsHide: true,
        timeout: 15_000,
      })
      if (isDockerServerVersion(stdout)) return true
    } catch {
      // A compatible engine can reject the other engine's Go-template field.
    }
  }
  return false
}

export async function resolveDockerCommand(options = {}) {
  if (!options.noCache && resolvedDockerCommand) return resolvedDockerCommand
  const env = options.env ?? process.env
  const host = options.host ?? resolveHostPlatform({ env })
  const configured = env.OPENLINK_DOCKER_COMMAND?.trim()
  const candidates = [configured, 'docker', ...host.dockerCliCandidates].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      try { await access(candidate, constants.X_OK) } catch { continue }
    }
    if (await commandWorks(candidate)) {
      // Docker invokes sibling credential helpers by basename. A per-user
      // Desktop install may expose docker.exe only through its absolute path,
      // so its directory must also be visible to child processes.
      exposeDockerCompanionTools(candidate, host, env)
      if (!options.noCache) resolvedDockerCommand = candidate
      return candidate
    }
  }
  throw new Error(
    `Docker CLI is not installed for ${host.platform}/${host.architecture}. Install Docker Desktop or set OPENLINK_DOCKER_COMMAND to its absolute docker executable.`,
  )
}

async function launchDockerDesktop(host) {
  if (host.platform === 'darwin') {
    for (const args of [
      ['-g', '-b', 'com.electron.dockerdesktop'],
      ['-ga', 'Docker Desktop'],
      ['-ga', 'Docker'],
    ]) {
      if (await commandWorks('open', args)) return
    }
    return
  }
  if (host.platform === 'win32') {
    for (const candidate of host.dockerDesktopCandidates) {
      try { await access(candidate, constants.X_OK) } catch { continue }
      const child = spawn(candidate, [], {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return
    }
  }
}

export async function ensureDockerEngine(options = {}) {
  const env = options.env ?? process.env
  const host = options.host ?? resolveHostPlatform({ env })
  const docker = options.command ?? await resolveDockerCommand({ env, host })
  const probe = () => engineWorks(docker)
  if (await probe()) return docker

  // An explicit command is an operator-selected engine boundary (for example
  // OpenLink's bundled Podman on macOS). Never cross that boundary by
  // launching Docker Desktop when the selected engine is still converging or
  // unhealthy.
  const configured = env.OPENLINK_DOCKER_COMMAND?.trim()
  if (!configured) await launchDockerDesktop(host)
  const timeoutMs = options.timeoutMs ?? 180_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return docker
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  }
  if (configured) {
    throw new Error(`Configured container engine did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds: ${configured}`)
  }
  throw new Error(`Docker Desktop did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds on ${host.platform}`)
}
