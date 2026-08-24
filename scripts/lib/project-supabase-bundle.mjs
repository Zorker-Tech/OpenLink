import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const HEX_64 = /^[a-f0-9]{64}$/
const BUNDLE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/

export const PROJECT_SUPABASE_BUNDLE_SCHEMA_VERSION = 1

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function releaseKeyId(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Project Supabase release key must be Ed25519')
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

export function signBundleManifest(manifest, privateKey) {
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Project Supabase release signing key must be Ed25519')
  return sign(null, Buffer.from(canonicalJson(manifest)), key).toString('base64')
}

export function verifyBundleManifestSignature(manifest, signature, publicKey) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error('Project Supabase bundle signature is invalid')
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Project Supabase release key must be Ed25519')
  if (!verify(null, Buffer.from(canonicalJson(manifest)), key, Buffer.from(signature, 'base64'))) throw new Error('Project Supabase bundle signature verification failed')
}

export async function sha256FileStreaming(path) {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function walkFiles(root, current, output) {
  for (const name of (await readdir(current)).sort()) {
    const path = resolve(current, name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error(`Project Supabase bundle cannot contain symbolic link ${relative(root, path)}`)
    if (metadata.isDirectory()) await walkFiles(root, path, output)
    else if (metadata.isFile()) {
      const name = relative(root, path).split(sep).join('/')
      if (['bundle.manifest.json', 'bundle.signature'].includes(name)) continue
      output.push({ path: name, sha256: await sha256FileStreaming(path), bytes: metadata.size })
    } else throw new Error(`Project Supabase bundle contains unsupported entry ${relative(root, path)}`)
  }
}

export async function bundleFileEntries(root) {
  const files = []
  await walkFiles(resolve(root), resolve(root), files)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) throw new Error(`${label} has unsupported fields`)
}

export function validateBundleManifest(manifest, lock, architecture) {
  exactKeys(manifest, ['schemaVersion', 'product', 'release', 'architecture', 'keyId', 'lockSha256', 'runtimeSpecSha256', 'configurationTreeSha256', 'upgradesSha256', 'imageManifestSha256', 'files'], 'Project Supabase bundle manifest')
  if (manifest.schemaVersion !== PROJECT_SUPABASE_BUNDLE_SCHEMA_VERSION || manifest.product !== 'openlink-project-supabase') throw new Error('Project Supabase bundle manifest identity is invalid')
  exactKeys(manifest.release, ['tag', 'commit'], 'Project Supabase bundle release')
  if (manifest.release.tag !== lock.release.tag || manifest.release.commit !== lock.release.commit) throw new Error('Project Supabase bundle release does not match lock')
  if (manifest.architecture !== architecture) throw new Error(`Project Supabase bundle architecture ${manifest.architecture} does not match ${architecture}`)
  for (const [field, expected] of [
    ['runtimeSpecSha256', lock.configuration.runtimeSpecSha256],
    ['configurationTreeSha256', lock.configuration.treeSha256],
    ['upgradesSha256', lock.configuration.upgradesSha256],
  ]) if (!HEX_64.test(manifest[field]) || manifest[field] !== expected) throw new Error(`Project Supabase bundle ${field} does not match lock`)
  for (const field of ['keyId', 'lockSha256', 'imageManifestSha256']) if (!HEX_64.test(manifest[field])) throw new Error(`Project Supabase bundle ${field} is invalid`)
  if (!Array.isArray(manifest.files) || manifest.files.length < 5) throw new Error('Project Supabase bundle file manifest is incomplete')
  const paths = new Set()
  for (const file of manifest.files) {
    exactKeys(file, ['path', 'sha256', 'bytes'], 'Project Supabase bundle file')
    if (typeof file.path !== 'string' || !BUNDLE_PATH.test(file.path) || file.path.includes('//') || paths.has(file.path)) throw new Error(`Project Supabase bundle file path ${file.path} is invalid or duplicated`)
    if (!HEX_64.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`Project Supabase bundle file metadata for ${file.path} is invalid`)
    paths.add(file.path)
  }
  for (const required of ['runtime.lock.json', 'runtime.spec.json', 'configuration/upgrades.json', 'image-manifest.json']) if (!paths.has(required)) throw new Error(`Project Supabase bundle is missing ${required}`)
  const archives = manifest.files.filter((file) => file.path.startsWith('images/') && file.path.endsWith('.docker.tar'))
  if (archives.length !== lock.services.length) throw new Error('Project Supabase bundle image archive set is incomplete')
  return manifest
}

export async function verifyBundleFiles(root, manifest) {
  const absoluteRoot = resolve(root)
  const expected = `${absoluteRoot}${sep}`
  for (const file of manifest.files) {
    const path = resolve(absoluteRoot, file.path)
    if (!path.startsWith(expected)) throw new Error(`Project Supabase bundle path ${file.path} escapes root`)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes) throw new Error(`Project Supabase bundle file ${file.path} size or type mismatch`)
    if (await sha256FileStreaming(path) !== file.sha256) throw new Error(`Project Supabase bundle file ${file.path} checksum mismatch`)
  }
  const actual = await bundleFileEntries(absoluteRoot)
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new Error('Project Supabase bundle contains unmanifested or missing files')
}

export async function readTrustedReleaseKeys(path) {
  const input = JSON.parse(await readFile(path, 'utf8'))
  exactKeys(input, ['schemaVersion', 'keys'], 'Project Supabase release trust roots')
  if (input.schemaVersion !== 1 || !Array.isArray(input.keys) || input.keys.length === 0) throw new Error('Project Supabase release trust roots are invalid')
  const keys = new Map()
  for (const candidate of input.keys) {
    exactKeys(candidate, ['keyId', 'publicKeyPem', 'status'], 'Project Supabase release trust key')
    if (candidate.status !== 'active' && candidate.status !== 'retired') throw new Error(`Project Supabase release key ${candidate.keyId} status is invalid`)
    if (candidate.keyId !== releaseKeyId(candidate.publicKeyPem) || keys.has(candidate.keyId)) throw new Error(`Project Supabase release key ${candidate.keyId} identity is invalid or duplicated`)
    keys.set(candidate.keyId, candidate)
  }
  return keys
}
