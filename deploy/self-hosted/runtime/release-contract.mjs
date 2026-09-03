import { constants } from 'node:fs'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { posix, resolve, sep } from 'node:path'

const RELEASE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/
const DIGEST = /^[a-f0-9]{64}$/
const KEY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/
const METADATA_FILES = new Set(['release.json'])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function normalizeReleaseId(value) {
  invariant(typeof value === 'string' && RELEASE_ID.test(value), 'Self-hosted release id is invalid')
  return value
}

export function normalizeTarget(input = {}) {
  const platform = input.platform
  const architecture = input.architecture === 'x64' ? 'amd64' : input.architecture
  if (platform === 'darwin' && architecture === 'arm64') {
    return { platform, architecture, provider: 'applehv', diskFormat: 'raw', triple: 'darwin-arm64' }
  }
  if (platform === 'linux' && (architecture === 'amd64' || architecture === 'arm64')) {
    return { platform, architecture, provider: 'qemu', diskFormat: 'qcow2', triple: `linux-${architecture}` }
  }
  throw new Error(`Unsupported self-hosted release target ${String(platform)}/${String(architecture)}`)
}

export function safeReleasePath(value) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 1024, 'Release inventory path is invalid')
  invariant(!value.includes('\\') && !value.startsWith('/') && !/[\0-\x1f\x7f]/.test(value), 'Release inventory path is unsafe')
  const normalized = posix.normalize(value)
  invariant(normalized === value && normalized !== '.' && !normalized.startsWith('../'), 'Release inventory path traversal is not allowed')
  return normalized
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'Canonical JSON does not support non-finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  invariant(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'Canonical JSON only supports plain objects')
  const result = {}
  for (const key of Object.keys(value).sort()) {
    invariant(value[key] !== undefined, `Canonical JSON property ${key} is undefined`)
    result[key] = canonicalValue(value[key])
  }
  return result
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

export function parseReleaseTrustPolicy(document, options = {}) {
  invariant(document && typeof document === 'object' && !Array.isArray(document), 'Release trust root is invalid')
  invariant(document.schemaVersion === 1, 'Unsupported release trust root schema')
  invariant(Number.isSafeInteger(document.minimumReleaseSequence) && document.minimumReleaseSequence >= 1, 'Release trust minimum sequence is invalid')
  invariant(document.keys && typeof document.keys === 'object' && !Array.isArray(document.keys), 'Release trust keys are invalid')
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now())
  invariant(Number.isFinite(now), 'Release trust evaluation time is invalid')
  const trustedKeys = {}
  for (const [keyId, record] of Object.entries(document.keys)) {
    invariant(KEY_ID.test(keyId), `Release trust key id is invalid: ${keyId}`)
    invariant(record && typeof record === 'object' && !Array.isArray(record), `Release trust record is invalid: ${keyId}`)
    invariant(record.algorithm === 'Ed25519', `Release trust key algorithm is invalid: ${keyId}`)
    invariant(['active', 'retired', 'revoked'].includes(record.status), `Release trust key status is invalid: ${keyId}`)
    invariant(typeof record.publicKeyPem === 'string' && record.publicKeyPem.length > 0, `Release trust public key is invalid: ${keyId}`)
    const notBefore = record.notBefore === undefined ? undefined : Date.parse(record.notBefore)
    const notAfter = record.notAfter === undefined ? undefined : Date.parse(record.notAfter)
    invariant(notBefore === undefined || Number.isFinite(notBefore), `Release trust notBefore is invalid: ${keyId}`)
    invariant(notAfter === undefined || Number.isFinite(notAfter), `Release trust notAfter is invalid: ${keyId}`)
    invariant(notBefore === undefined || notAfter === undefined || notBefore < notAfter, `Release trust validity window is invalid: ${keyId}`)
    if (record.status !== 'active' || (notBefore !== undefined && now < notBefore) || (notAfter !== undefined && now >= notAfter)) continue
    trustedKeys[keyId] = record.publicKeyPem
  }
  invariant(Object.keys(trustedKeys).length > 0, 'Release trust root contains no currently active keys')
  return { trustedKeys, minimumReleaseSequence: document.minimumReleaseSequence }
}

export function parseReleaseTrustRoot(document, options = {}) {
  return parseReleaseTrustPolicy(document, options).trustedKeys
}

async function digestRegularFile(path) {
  const before = await lstat(path)
  invariant(before.isFile(), `Release inventory entry is not a regular file: ${path}`)
  invariant((before.mode & 0o022) === 0, `Release file is group/world writable: ${path}`)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat()
    invariant(current.isFile() && current.dev === before.dev && current.ino === before.ino, `Release file changed while inventorying: ${path}`)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk)
      bytes += chunk.length
    }
    invariant(bytes === current.size, `Release file size changed while inventorying: ${path}`)
    return {
      mode: (current.mode & 0o7777).toString(8).padStart(4, '0'),
      size: current.size,
      sha256: hash.digest('hex'),
    }
  } finally {
    await handle.close()
  }
}

export async function createReleaseInventory(root, options = {}) {
  const absoluteRoot = resolve(root)
  const ignored = new Set(options.ignored ?? METADATA_FILES)
  const entries = []

  async function visit(directory, relativeDirectory = '') {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => lexicalCompare(left.name, right.name))
    for (const child of children) {
      const relative = safeReleasePath(relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name)
      if (!relativeDirectory && ignored.has(relative)) continue
      const absolute = resolve(absoluteRoot, ...relative.split('/'))
      invariant(absolute === absoluteRoot || absolute.startsWith(`${absoluteRoot}${sep}`), `Release path escapes staging root: ${relative}`)
      if (child.isSymbolicLink()) throw new Error(`Release payload contains a symbolic link: ${relative}`)
      if (child.isDirectory()) {
        await visit(absolute, relative)
        continue
      }
      if (!child.isFile()) throw new Error(`Release payload contains a non-regular file: ${relative}`)
      entries.push({ path: relative, ...await digestRegularFile(absolute) })
    }
  }

  await visit(absoluteRoot)
  return entries.sort((left, right) => lexicalCompare(left.path, right.path))
}

function validateInventory(inventory) {
  invariant(Array.isArray(inventory), 'Release manifest inventory is invalid')
  let previous = ''
  for (const entry of inventory) {
    invariant(entry && typeof entry === 'object' && !Array.isArray(entry), 'Release inventory entry is invalid')
    const path = safeReleasePath(entry.path)
    invariant(path > previous, 'Release inventory paths must be unique and sorted')
    invariant(typeof entry.mode === 'string' && /^[0-7]{4}$/.test(entry.mode), `Release inventory mode is invalid: ${path}`)
    invariant((Number.parseInt(entry.mode, 8) & 0o022) === 0, `Release inventory contains a writable file: ${path}`)
    invariant((Number.parseInt(entry.mode, 8) & 0o7000) === 0, `Release inventory contains special permission bits: ${path}`)
    invariant(Number.isSafeInteger(entry.size) && entry.size >= 0, `Release inventory size is invalid: ${path}`)
    invariant(typeof entry.sha256 === 'string' && DIGEST.test(entry.sha256), `Release inventory digest is invalid: ${path}`)
    previous = path
  }
  return inventory
}

export async function verifyReleaseInventory(root, inventory) {
  validateInventory(inventory)
  const actual = await createReleaseInventory(root)
  invariant(actual.length === inventory.length, `Release inventory file count mismatch: expected ${inventory.length}, received ${actual.length}`)
  for (let index = 0; index < inventory.length; index += 1) {
    const expected = inventory[index]
    const received = actual[index]
    invariant(received.path === expected.path, `Unexpected or missing release file near ${expected.path}`)
    invariant(received.mode === expected.mode, `Release file mode mismatch: ${expected.path}`)
    invariant(received.size === expected.size, `Release file size mismatch: ${expected.path}`)
    invariant(received.sha256 === expected.sha256, `Release file digest mismatch: ${expected.path}`)
  }
  return true
}

function unsignedManifest(manifest) {
  invariant(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Release manifest is invalid')
  const { signature, ...unsigned } = manifest
  return unsigned
}

function validateManifestShape(manifest) {
  invariant(manifest.schemaVersion === 1, 'Unsupported self-hosted release manifest schema')
  invariant(manifest.contractVersion === 1, 'Unsupported self-hosted release contract version')
  invariant(manifest.product === 'OpenLink', 'Release manifest product is invalid')
  normalizeReleaseId(manifest.releaseId)
  invariant(Number.isSafeInteger(manifest.releaseSequence) && manifest.releaseSequence >= 1, 'Release manifest sequence is invalid')
  const target = normalizeTarget(manifest.target)
  invariant(canonicalJson(target) === canonicalJson(manifest.target), 'Release target is not canonical')
  validateInventory(manifest.inventory)
  const compatibility = manifest.compatibility
  invariant(compatibility && Number.isSafeInteger(compatibility.stateSchema) && compatibility.stateSchema >= 1, 'Release state compatibility is invalid')
  invariant(Number.isSafeInteger(compatibility.minimumStateSchema) && compatibility.minimumStateSchema >= 1 && compatibility.minimumStateSchema <= compatibility.stateSchema, 'Release minimum state compatibility is invalid')
  invariant(Number.isSafeInteger(compatibility.maximumStateSchema) && compatibility.maximumStateSchema >= compatibility.stateSchema, 'Release maximum state compatibility is invalid')
  return manifest
}

export function signReleaseManifest(manifest, options = {}) {
  const unsigned = validateManifestShape(unsignedManifest(manifest))
  invariant(typeof options.keyId === 'string' && KEY_ID.test(options.keyId), 'Release signing key id is invalid')
  invariant(options.privateKey, 'Release signing private key is required')
  const privateKey = options.privateKey?.type === 'private' ? options.privateKey : createPrivateKey(options.privateKey)
  invariant(privateKey.asymmetricKeyType === 'ed25519', 'Release signing key must be Ed25519')
  const value = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64')
  return { ...unsigned, signature: { algorithm: 'Ed25519', keyId: options.keyId, value } }
}

export function verifyReleaseManifest(manifest, options = {}) {
  const unsigned = validateManifestShape(unsignedManifest(manifest))
  const signature = manifest.signature
  invariant(signature?.algorithm === 'Ed25519' && typeof signature.keyId === 'string' && KEY_ID.test(signature.keyId), 'Release signature metadata is invalid')
  invariant(typeof signature.value === 'string' && signature.value.length > 0, 'Release signature value is invalid')
  const trusted = options.trustedKeys?.[signature.keyId]
  invariant(trusted, `Release signing key is not trusted: ${signature.keyId}`)
  const publicKey = trusted?.type === 'public' ? trusted : createPublicKey(trusted)
  invariant(publicKey.asymmetricKeyType === 'ed25519', 'Trusted release key must be Ed25519')
  invariant(verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature.value, 'base64')), 'Release manifest signature verification failed')
  if (options.expectedTarget) {
    const expected = normalizeTarget(options.expectedTarget)
    invariant(canonicalJson(expected) === canonicalJson(unsigned.target), `Release target mismatch: expected ${expected.triple}, received ${unsigned.target.triple}`)
  }
  if (options.minimumReleaseSequence !== undefined) {
    invariant(Number.isSafeInteger(options.minimumReleaseSequence) && options.minimumReleaseSequence >= 1, 'Release trust minimum sequence is invalid')
    invariant(unsigned.releaseSequence >= options.minimumReleaseSequence, `Release sequence ${unsigned.releaseSequence} is below the trusted minimum ${options.minimumReleaseSequence}`)
  }
  return unsigned
}
