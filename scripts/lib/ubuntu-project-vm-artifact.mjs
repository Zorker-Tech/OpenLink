const ARCHITECTURES = new Set(['amd64', 'arm64'])

function fail(message) {
  throw new Error(`OpenLink Ubuntu Project VM artifact is invalid: ${message}`)
}

/**
 * Validate the immutable T1 base artifact manifest before the lifecycle
 * supervisor hands it to the Agent Host. The disk filename is deliberately a
 * basename: a manifest must never be able to point outside its artifact root.
 */
export function assertUbuntuProjectVmArtifactManifest(manifest, expected = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object')
  if (manifest.schemaVersion !== 1) fail('unsupported schemaVersion')
  const platform = manifest.platform
  if (!platform || typeof platform !== 'object' || platform.os !== 'linux' || platform.provider !== 'qemu') {
    fail('platform must be linux/qemu')
  }
  if (!ARCHITECTURES.has(platform.architecture)) fail('platform architecture is unsupported')
  if (expected.architecture && platform.architecture !== expected.architecture) {
    fail(`platform mismatch (${platform.architecture} != ${expected.architecture})`)
  }
  if (typeof manifest.disk !== 'string' || !manifest.disk.trim()) fail('disk is missing')
  const disk = manifest.disk.trim()
  if (disk.includes('/') || disk.includes('\\') || disk === '.' || disk === '..') fail('disk must be a basename')
  if (!Number.isSafeInteger(manifest.diskBytes) || manifest.diskBytes <= 0) fail('diskBytes is invalid')
  if (typeof manifest.diskSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.diskSha256)) fail('diskSha256 is invalid')
  if (typeof manifest.baseFingerprint !== 'string' || !manifest.baseFingerprint) fail('baseFingerprint is missing')
  for (const [name, value] of [['kernel', manifest.kernel], ['initrd', manifest.initrd]]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} is missing`)
    if (typeof value.file !== 'string' || !value.file.trim()) fail(`${name}.file is missing`)
    if (value.file.includes('/') || value.file.includes('\\') || value.file === '.' || value.file === '..') fail(`${name}.file must be a basename`)
    if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) fail(`${name}.bytes is invalid`)
    if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) fail(`${name}.sha256 is invalid`)
  }
  if (manifest.rootDevice !== '/dev/vda') fail('rootDevice must be /dev/vda for the payload boot contract')
  if (!Number.isSafeInteger(manifest.diskVirtualBytes) || manifest.diskVirtualBytes < 10 * 1024 * 1024 * 1024) {
    fail('diskVirtualBytes is invalid')
  }
  if (manifest.diskFormat !== 'qcow2') fail('diskFormat must be qcow2')
  if (!manifest.desktop || typeof manifest.desktop !== 'object' || manifest.desktop.websockifyPort !== 6080) {
    fail('desktop contract is invalid')
  }
  if (!manifest.sourceImage || typeof manifest.sourceImage !== 'object' || !/^[a-f0-9]{64}$/i.test(manifest.sourceImage.sha256 ?? '')) {
    fail('sourceImage is invalid')
  }
  if (typeof manifest.builtAt !== 'string' || !Number.isFinite(Date.parse(manifest.builtAt))) fail('builtAt is invalid')
  return {
    disk,
    diskPath: null,
    fingerprint: manifest.baseFingerprint,
    architecture: platform.architecture,
    kernel: { file: manifest.kernel.file, sha256: manifest.kernel.sha256, bytes: manifest.kernel.bytes },
    initrd: { file: manifest.initrd.file, sha256: manifest.initrd.sha256, bytes: manifest.initrd.bytes },
    rootDevice: manifest.rootDevice,
  }
}

export const UBUNTU_PROJECT_VM_ARCHITECTURE = {
  x64: 'amd64',
  arm64: 'arm64',
}
