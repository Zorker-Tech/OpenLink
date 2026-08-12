import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Give every OpenLink command the same private Podman state. In particular,
 * Podman otherwise writes VM disks to the macOS system-volume home directory.
 * Keeping the state under .openlink-runtime makes disks product-owned and
 * prevents a large build from exhausting the OS volume while the workspace
 * data volume still has capacity.
 */
export async function configureBundledPodmanRuntime(root) {
  const runtimeRoot = resolve(root, '.openlink-runtime')
  const toolchainRoot = resolve(runtimeRoot, 'toolchain', 'bin')
  const configRoot = resolve(runtimeRoot, 'podman-config')
  const dataRoot = resolve(runtimeRoot, 'podman-data')
  const containersRoot = resolve(configRoot, 'containers')

  process.env.OPENLINK_PODMAN_COMMAND ||= resolve(toolchainRoot, 'podman')
  process.env.CONTAINERS_HELPER_BINARY_DIR ||= toolchainRoot
  process.env.XDG_CONFIG_HOME ||= configRoot
  process.env.XDG_DATA_HOME ||= dataRoot
  if (process.platform === 'darwin') process.env.CONTAINERS_MACHINE_PROVIDER ||= 'applehv'

  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await mkdir(containersRoot, { recursive: true, mode: 0o700 })
  const policyPath = resolve(containersRoot, 'policy.json')
  const containersConfigPath = resolve(containersRoot, 'containers.conf')
  try {
    const policy = (await readFile(policyPath, 'utf8')).trim()
    if (!policy) await writeFile(policyPath, '{"default":[{"type":"insecureAcceptAnything"}]}\n', { mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(policyPath, '{"default":[{"type":"insecureAcceptAnything"}]}\n', { mode: 0o600 })
  }
  try {
    const config = await readFile(containersConfigPath, 'utf8')
    if (!config.includes('helper_binaries_dir')) {
      await writeFile(containersConfigPath, `[engine]\nhelper_binaries_dir = ["${toolchainRoot}"]\n`, { mode: 0o600 })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(containersConfigPath, `[engine]\nhelper_binaries_dir = ["${toolchainRoot}"]\n`, { mode: 0o600 })
  }

  return { runtimeRoot, toolchainRoot, configRoot, dataRoot, podman: process.env.OPENLINK_PODMAN_COMMAND }
}
