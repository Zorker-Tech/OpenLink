import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bundledToolchainPaths, resolveHostPlatform } from './host-platform.mjs'
import { ensureMacPlatformContainerEngine, platformEngineIdentity } from '../../deploy/self-hosted/runtime/platform-container-engine.mjs'

export { platformEngineIdentity }

/**
 * Ensure the product-owned macOS Podman VM is the active platform container
 * engine. Project VMs use direct AppleHV in the current runtime; old `olp-*`
 * Podman machines can remain after an earlier release and must be stopped
 * before Podman will allow the dedicated platform machine to start.
 */
export async function ensureBundledPodmanPlatformEngine(root, options = {}) {
  const env = options.env ?? process.env
  const host = options.host ?? resolveHostPlatform({ env })
  if (host.platform !== 'darwin') return { managed: false }

  const toolchain = bundledToolchainPaths(root, host.platform)
  const podman = options.podman ?? env.OPENLINK_PODMAN_COMMAND ?? toolchain.podman
  return ensureMacPlatformContainerEngine({
    env,
    execFile: options.execFile,
    startDirectAppleHv: options.startDirectAppleHv,
    releaseRoot: root,
    stateRoot: options.stateRoot ?? resolve(root, '.openlink-runtime'),
    baseDisk: options.baseDisk ?? resolve(root, '.openlink-runtime/project-vm-base/openlink-project-vm-base-arm64.raw'),
    podman,
    cpus: options.cpus,
    memoryMb: options.memoryMb,
    diskGb: options.diskGb,
  })
}

/**
 * Give every OpenLink command the same private Podman state. In particular,
 * Podman otherwise writes VM disks to the macOS system-volume home directory.
 * Keeping the state under .openlink-runtime makes disks product-owned and
 * prevents a large build from exhausting the OS volume while the workspace
 * data volume still has capacity.
 */
export async function configureBundledPodmanRuntime(root) {
  const runtimeRoot = resolve(root, '.openlink-runtime')
  const host = resolveHostPlatform()
  const toolchain = bundledToolchainPaths(root)
  const toolchainRoot = toolchain.bin
  const configRoot = resolve(runtimeRoot, 'podman-config')
  const dataRoot = resolve(runtimeRoot, 'podman-data')
  const containersRoot = resolve(configRoot, 'containers')

  process.env.OPENLINK_PODMAN_COMMAND ||= toolchain.podman
  process.env.CONTAINERS_HELPER_BINARY_DIR ||= toolchainRoot
  process.env.XDG_CONFIG_HOME ||= configRoot
  process.env.XDG_DATA_HOME ||= dataRoot
  if (process.platform !== 'linux') process.env.CONTAINERS_MACHINE_PROVIDER ||= host.provider

  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await mkdir(containersRoot, { recursive: true, mode: 0o700 })
  const policyPath = resolve(containersRoot, 'policy.json')
  const containersConfigPath = resolve(containersRoot, 'containers.conf')
  process.env.CONTAINERS_CONF ||= containersConfigPath
  process.env.CONTAINERS_POLICY ||= policyPath
  process.env.PODMAN_CONNECTIONS_CONF ||= resolve(containersRoot, 'podman-connections.json')
  try {
    const policy = (await readFile(policyPath, 'utf8')).trim()
    if (!policy) await writeFile(policyPath, '{"default":[{"type":"insecureAcceptAnything"}]}\n', { mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(policyPath, '{"default":[{"type":"insecureAcceptAnything"}]}\n', { mode: 0o600 })
  }
  const machineVolumes = '[machine]\nvolumes = []\n'
  const engineConfig = `[engine]\nhelper_binaries_dir = ["${toolchainRoot.replaceAll('\\', '/')}"]\n`
  try {
    const config = await readFile(containersConfigPath, 'utf8')
    // A Project VM boots an immutable composefs root. Podman's default host
    // home-directory share targets /Users/... and makes that first boot fail
    // on Windows (and violates Project VM workspace isolation everywhere).
    // The Agent Host controls its explicit workspace mounts, so product-owned
    // Podman state must always opt out of implicit machine volumes.
    if (!config.includes('helper_binaries_dir') || !/^\s*volumes\s*=\s*\[\s*\]\s*$/m.test(config)) {
      const withoutMachineVolumes = config
        .replace(/^\s*\[machine\]\s*\r?\n(?:\s*[^\r\n]*\r?\n)*/m, '')
        .trim()
      await writeFile(containersConfigPath, `${withoutMachineVolumes || engineConfig}\n${machineVolumes}`, { mode: 0o600 })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(containersConfigPath, `${engineConfig}${machineVolumes}`, { mode: 0o600 })
  }

  return { runtimeRoot, toolchainRoot, configRoot, dataRoot, podman: process.env.OPENLINK_PODMAN_COMMAND }
}
