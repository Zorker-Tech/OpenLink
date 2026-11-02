import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../release-version.json', import.meta.url)), 'utf8'))
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const ARCHITECTURES = new Set(['t1', 't2', 'e1'])

if (!VERSION_PATTERN.test(manifest.version)) throw new Error('release-version.json version is invalid')
for (const architecture of ARCHITECTURES) {
  const value = manifest.architectures?.[architecture]
  if (!value || typeof value.release !== 'string') throw new Error(`release-version.json is missing ${architecture}`)
}

export const PRODUCT_VERSION = manifest.version
export const RELEASE_MANIFEST = Object.freeze(manifest)

export function releaseName(architecture) {
  if (!ARCHITECTURES.has(architecture)) throw new Error('release architecture must be t1, t2 or e1')
  return manifest.architectures[architecture].release
}

export function releaseCodename(architecture) {
  if (!ARCHITECTURES.has(architecture)) throw new Error('release architecture must be t1, t2 or e1')
  return manifest.architectures[architecture].codename
}

export function releaseChannel(architecture) {
  if (!ARCHITECTURES.has(architecture)) throw new Error('release architecture must be t1, t2 or e1')
  return manifest.architectures[architecture].channel
}
