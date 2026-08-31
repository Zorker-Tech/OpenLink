import assert from 'node:assert/strict'
import test from 'node:test'
import { assertProjectVmArtifactManifest, projectVmArtifactContract } from '../lib/project-vm-artifact.mjs'

test('defines independent AppleHV raw and Hyper-V VHDX artifact contracts', () => {
  const apple = projectVmArtifactContract({ platform: 'darwin', architecture: 'arm64', env: {} })
  const windows = projectVmArtifactContract({ platform: 'win32', architecture: 'x64', env: {} })
  assert.deepEqual(
    [apple.provider, apple.diskFormat, apple.ignitionPlatform, apple.cloneStrategy],
    ['applehv', 'raw', 'applehv', 'native-cow'],
  )
  assert.deepEqual(
    [windows.provider, windows.diskFormat, windows.ignitionPlatform, windows.cloneStrategy],
    ['hyperv', 'vhdx', 'hyperv', 'hyperv-differencing'],
  )
  assert.equal(windows.diskName, 'openlink-project-vm-base-x64.vhdx')
})

test('rejects a disk manifest produced for another native host provider', () => {
  const contract = projectVmArtifactContract({ platform: 'win32', architecture: 'x64', env: {} })
  const manifest = {
    disk: contract.diskName,
    diskLayout: contract.diskLayout,
    diskPlatform: {
      hostPlatform: 'darwin',
      provider: 'applehv',
      architecture: 'arm64',
      format: 'raw',
      ignitionPlatform: 'applehv',
      cloneStrategy: 'native-cow',
    },
  }
  assert.throws(() => assertProjectVmArtifactManifest(manifest, contract), /hostPlatform mismatch/)
})

test('accepts only a complete matching native platform declaration', () => {
  const contract = projectVmArtifactContract({ platform: 'win32', architecture: 'x64', env: {} })
  const manifest = {
    disk: contract.diskName,
    diskLayout: contract.diskLayout,
    diskPlatform: {
      hostPlatform: contract.hostPlatform,
      provider: contract.provider,
      architecture: contract.architecture,
      format: contract.diskFormat,
      ignitionPlatform: contract.ignitionPlatform,
      cloneStrategy: contract.cloneStrategy,
    },
  }
  assert.equal(assertProjectVmArtifactManifest(manifest, contract), manifest)
})
