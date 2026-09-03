import { basename } from 'node:path'
import { resolveHostPlatform } from './host-platform.mjs'

const CONTRACTS = Object.freeze({
  applehv: Object.freeze({
    hostPlatform: 'darwin',
    provider: 'applehv',
    diskFormat: 'raw',
    ignitionPlatform: 'applehv',
    diskLayout: 'podman-machine-os-efi-boot-root-applehv-ignition-v6',
    cloneStrategy: 'native-cow',
  }),
  hyperv: Object.freeze({
    hostPlatform: 'win32',
    provider: 'hyperv',
    diskFormat: 'vhdx',
    ignitionPlatform: 'hyperv',
    diskLayout: 'podman-machine-os-efi-boot-root-hyperv-ignition-v1',
    cloneStrategy: 'hyperv-differencing',
  }),
  qemu: Object.freeze({
    hostPlatform: 'linux',
    provider: 'qemu',
    diskFormat: 'qcow2',
    ignitionPlatform: 'qemu',
    diskLayout: 'podman-machine-os-efi-boot-root-qemu-ignition-v1',
    cloneStrategy: 'native-cow',
  }),
})

export function projectVmArtifactContract(options = {}) {
  const host = options.host ?? resolveHostPlatform(options)
  const contract = CONTRACTS[host.provider]
  if (!contract) {
    throw new Error(`Project VM artifact production is not implemented for native provider ${host.provider}`)
  }
  if (contract.hostPlatform !== host.platform || contract.diskFormat !== host.diskFormat) {
    throw new Error(`Project VM artifact contract does not match ${host.platform}/${host.diskFormat}`)
  }
  return {
    ...contract,
    architecture: host.platform === 'linux' && host.architecture === 'x64' ? 'amd64' : host.architecture,
    diskName: `openlink-project-vm-base-${host.platform === 'linux' && host.architecture === 'x64' ? 'amd64' : host.architecture}.${contract.diskFormat}`,
  }
}

export function assertProjectVmArtifactManifest(manifest, contract = projectVmArtifactContract()) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Project VM image manifest is invalid')
  const platform = manifest.diskPlatform
  if (!platform || typeof platform !== 'object') {
    throw new Error('Project VM image manifest does not declare its native disk platform')
  }
  const expected = {
    hostPlatform: contract.hostPlatform,
    provider: contract.provider,
    architecture: contract.architecture,
    format: contract.diskFormat,
    ignitionPlatform: contract.ignitionPlatform,
    cloneStrategy: contract.cloneStrategy,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (platform[key] !== value) {
      throw new Error(`Project VM disk ${key} mismatch: expected ${value}, received ${String(platform[key] ?? 'missing')}`)
    }
  }
  if (manifest.diskLayout !== contract.diskLayout) {
    throw new Error(`Project VM disk layout mismatch: expected ${contract.diskLayout}, received ${String(manifest.diskLayout ?? 'missing')}`)
  }
  if (basename(String(manifest.disk ?? '')) !== contract.diskName) {
    throw new Error(`Project VM disk filename mismatch: expected ${contract.diskName}`)
  }
  return manifest
}
