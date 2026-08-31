import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export const PROJECT_SUPABASE_LOCK_SCHEMA_VERSION = 1
export const PROJECT_SUPABASE_ARCHITECTURES = Object.freeze(['amd64', 'arm64'])
export const PROJECT_SUPABASE_REQUIRED_SERVICES = Object.freeze([
  'studio',
  'api-gw',
  'auth',
  'rest',
  'realtime',
  'storage',
  'imgproxy',
  'meta',
  'functions',
  'db',
  'supavisor',
])

const HEX_40 = /^[a-f0-9]{40}$/
const SHA_256 = /^sha256:[a-f0-9]{64}$/
const HEX_64 = /^[a-f0-9]{64}$/
const RELEASE_TAG = /^self-hosted\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const IMAGE_REFERENCE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} must contain exactly: ${required.join(', ')}`)
  }
}

export function parseSelfHostedVersion(tag) {
  const match = RELEASE_TAG.exec(tag)
  if (!match) throw new Error('Supabase release tag must be a stable self-hosted/vX.Y.Z tag')
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), version: `${match[1]}.${match[2]}.${match[3]}` }
}

export function compareSelfHostedTags(left, right) {
  const a = parseSelfHostedVersion(left)
  const b = parseSelfHostedVersion(right)
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export function latestSelfHostedTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) throw new Error('No Supabase self-hosted release tags were found')
  const candidates = [...new Set(tags)]
  for (const tag of candidates) parseSelfHostedVersion(tag)
  return candidates.sort(compareSelfHostedTags).at(-1)
}

export function validateProjectSupabaseLock(input) {
  const lock = object(input, 'Project Supabase lock')
  exactKeys(lock, ['schemaVersion', 'release', 'configuration', 'services', 'upgradeGates'], 'Project Supabase lock')
  if (lock.schemaVersion !== PROJECT_SUPABASE_LOCK_SCHEMA_VERSION) throw new Error('Project Supabase lock schemaVersion is unsupported')

  const release = object(lock.release, 'release')
  exactKeys(release, ['tag', 'version', 'tagObject', 'commit', 'repository'], 'release')
  const parsed = parseSelfHostedVersion(release.tag)
  if (release.version !== parsed.version) throw new Error('release.version does not match release.tag')
  if (!HEX_40.test(release.tagObject)) throw new Error('release.tagObject must be a 40-character Git object id')
  if (!HEX_40.test(release.commit)) throw new Error('release.commit must be a 40-character Git commit id')
  if (release.tagObject === release.commit) throw new Error('release.tagObject must record the annotated tag object separately from the peeled commit')
  if (release.repository !== 'https://github.com/supabase/supabase.git') throw new Error('release.repository must be the official Supabase repository')

  const configuration = object(lock.configuration, 'configuration')
  exactKeys(configuration, ['root', 'treeSha256', 'upgradesSha256', 'runtimeSpecSha256'], 'configuration')
  if (configuration.root !== 'docker') throw new Error('configuration.root must be docker')
  if (!HEX_64.test(configuration.treeSha256)) throw new Error('configuration.treeSha256 must be a SHA-256 hex digest')
  if (!HEX_64.test(configuration.upgradesSha256)) throw new Error('configuration.upgradesSha256 must be a SHA-256 hex digest')
  if (!HEX_64.test(configuration.runtimeSpecSha256)) throw new Error('configuration.runtimeSpecSha256 must be a SHA-256 hex digest')

  if (!Array.isArray(lock.services)) throw new Error('services must be an array')
  const names = new Set()
  const aliases = new Set()
  for (const [index, candidate] of lock.services.entries()) {
    const service = object(candidate, `services[${index}]`)
    exactKeys(service, ['name', 'image', 'aliases', 'platforms'], `services[${index}]`)
    if (!SERVICE_NAME.test(service.name)) throw new Error(`services[${index}].name is invalid`)
    if (names.has(service.name)) throw new Error(`Duplicate Supabase service ${service.name}`)
    names.add(service.name)
    if (!IMAGE_REFERENCE.test(service.image) || service.image.includes('@')) throw new Error(`Service ${service.name} image must be a tagged OCI reference`)
    if (!Array.isArray(service.aliases) || service.aliases.some((alias) => !SERVICE_NAME.test(alias))) throw new Error(`Service ${service.name} aliases are invalid`)
    for (const alias of [service.name, ...service.aliases]) {
      if (aliases.has(alias)) throw new Error(`Duplicate Supabase network alias ${alias}`)
      aliases.add(alias)
    }
    const platforms = object(service.platforms, `Service ${service.name} platforms`)
    exactKeys(platforms, PROJECT_SUPABASE_ARCHITECTURES, `Service ${service.name} platforms`)
    for (const architecture of PROJECT_SUPABASE_ARCHITECTURES) {
      const platform = object(platforms[architecture], `Service ${service.name} linux/${architecture}`)
      exactKeys(platform, ['digest', 'size'], `Service ${service.name} linux/${architecture}`)
      if (!SHA_256.test(platform.digest)) throw new Error(`Service ${service.name} linux/${architecture} digest is invalid`)
      if (!Number.isSafeInteger(platform.size) || platform.size <= 0) throw new Error(`Service ${service.name} linux/${architecture} size is invalid`)
    }
  }
  exactKeys(Object.fromEntries([...names].map((name) => [name, true])), PROJECT_SUPABASE_REQUIRED_SERVICES, 'services')

  if (!Array.isArray(lock.upgradeGates)) throw new Error('upgradeGates must be an array')
  let previousVersion
  for (const [index, candidate] of lock.upgradeGates.entries()) {
    const gate = object(candidate, `upgradeGates[${index}]`)
    exactKeys(gate, ['version', 'breaking', 'gate', 'migrationGuideUrl', 'requires'], `upgradeGates[${index}]`)
    const versionTag = `self-hosted/v${gate.version}`
    parseSelfHostedVersion(versionTag)
    if (previousVersion && compareSelfHostedTags(`self-hosted/v${previousVersion}`, versionTag) >= 0) throw new Error('upgradeGates must be strictly ordered by version')
    previousVersion = gate.version
    if (typeof gate.breaking !== 'boolean') throw new Error(`upgradeGates[${index}].breaking must be boolean`)
    if (gate.gate !== null && (typeof gate.gate !== 'string' || !/^utils\/[A-Za-z0-9._-]+\.sh$/.test(gate.gate))) throw new Error(`upgradeGates[${index}].gate is invalid`)
    if (gate.migrationGuideUrl !== null && (typeof gate.migrationGuideUrl !== 'string' || !gate.migrationGuideUrl.startsWith('https://'))) throw new Error(`upgradeGates[${index}].migrationGuideUrl is invalid`)
    if (!Array.isArray(gate.requires) || gate.requires.some((requirement) => typeof requirement !== 'string' || !requirement.trim())) throw new Error(`upgradeGates[${index}].requires is invalid`)
  }
  return lock
}

export async function readProjectSupabaseLock(path) {
  return validateProjectSupabaseLock(JSON.parse(await readFile(path, 'utf8')))
}

async function hashTreeEntry(hash, root, path) {
  const metadata = await lstat(path)
  const name = relative(root, path).split(sep).join('/')
  if (metadata.isSymbolicLink()) {
    hash.update(`link\0${name}\0${await readlink(path)}\0`)
    return
  }
  if (metadata.isDirectory()) {
    hash.update(`directory\0${name}\0`)
    for (const entry of (await readdir(path)).sort()) {
      if (entry === '.git') continue
      await hashTreeEntry(hash, root, resolve(path, entry))
    }
    return
  }
  if (!metadata.isFile()) throw new Error(`Unsupported Supabase configuration entry ${name}`)
  // File mode bits are not a portable source identity: NTFS checkouts cannot
  // represent Git's POSIX executable bit. Runtime permissions are assigned
  // explicitly in the Linux image, so the reviewed tree digest binds paths
  // and bytes identically on macOS, Windows and Linux.
  hash.update(`file\0${name}\0`)
  hash.update(await readFile(path))
  hash.update('\0')
}

export async function hashConfigurationTree(root) {
  const absoluteRoot = resolve(root)
  const hash = createHash('sha256')
  hash.update('project-supabase-configuration-v2\0')
  for (const entry of (await readdir(absoluteRoot)).sort()) {
    if (entry === '.git') continue
    await hashTreeEntry(hash, absoluteRoot, resolve(absoluteRoot, entry))
  }
  return hash.digest('hex')
}

export function normalizeUpgradeGates(upgrades) {
  const manifest = object(upgrades, 'Supabase upgrades manifest')
  return Object.entries(manifest)
    .filter(([version]) => version !== '_schema')
    .map(([version, candidate]) => {
      const value = object(candidate, `Supabase upgrade ${version}`)
      return {
        version,
        breaking: value.breaking === true,
        gate: value.gate ?? null,
        migrationGuideUrl: value.migration_guide_url ?? null,
        requires: Array.isArray(value.requires) ? value.requires : [],
      }
    })
    .sort((left, right) => compareSelfHostedTags(`self-hosted/v${left.version}`, `self-hosted/v${right.version}`))
}
