import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { PROJECT_SUPABASE_ARCHITECTURES } from './project-supabase-lock.mjs'

const SHA_256 = /^sha256:[a-f0-9]{64}$/
const HEX_64 = /^[a-f0-9]{64}$/

export function nodeArchitecture(value = process.arch) {
  if (value === 'x64') return 'amd64'
  if (value === 'arm64') return 'arm64'
  throw new Error(`Project Supabase does not support host architecture ${value}`)
}

export function targetArchitecture(value) {
  const architecture = value || nodeArchitecture()
  if (!PROJECT_SUPABASE_ARCHITECTURES.includes(architecture)) throw new Error(`Unsupported Project Supabase architecture ${architecture}`)
  return architecture
}

export function archiveName(service, architecture) {
  return `${service.name}-${architecture}-${service.platforms[architecture].digest.slice('sha256:'.length, 'sha256:'.length + 20)}.docker.tar`
}

export function immutablePullReference(image, digest) {
  if (!SHA_256.test(digest)) throw new Error(`Invalid image digest ${digest}`)
  const separator = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  if (colon <= separator) throw new Error(`Image ${image} is not tagged`)
  return `${image.slice(0, colon)}@${digest}`
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function validateImageArtifactManifest(input, lock, root) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Project Supabase image manifest must be an object')
  if (input.schemaVersion !== 1) throw new Error('Project Supabase image manifest schemaVersion is unsupported')
  if (input.release?.tag !== lock.release.tag || input.release?.commit !== lock.release.commit) throw new Error('Project Supabase image manifest release does not match lock')
  const architecture = targetArchitecture(input.architecture)
  if (input.configurationTreeSha256 !== lock.configuration.treeSha256) throw new Error('Project Supabase image manifest configuration does not match lock')
  if (!Array.isArray(input.images) || input.images.length !== lock.services.length) throw new Error('Project Supabase image manifest is incomplete')
  const names = new Set()
  for (const artifact of input.images) {
    if (!artifact || typeof artifact !== 'object') throw new Error('Project Supabase image artifact is invalid')
    const service = lock.services.find((candidate) => candidate.name === artifact.service)
    if (!service || names.has(artifact.service)) throw new Error(`Project Supabase image artifact ${artifact.service} is unexpected or duplicated`)
    names.add(artifact.service)
    const expected = service.platforms[architecture]
    if (artifact.image !== service.image || artifact.platformDigest !== expected.digest) throw new Error(`Project Supabase image artifact ${service.name} does not match lock`)
    if (!SHA_256.test(artifact.imageId)) throw new Error(`Project Supabase image artifact ${service.name} imageId is invalid`)
    if (!HEX_64.test(artifact.archiveSha256) || !Number.isSafeInteger(artifact.archiveBytes) || artifact.archiveBytes <= 1024) throw new Error(`Project Supabase image artifact ${service.name} archive metadata is invalid`)
    if (basename(artifact.archive) !== artifact.archive || artifact.archive.includes('..')) throw new Error(`Project Supabase image artifact ${service.name} archive path is invalid`)
    const path = resolve(root, artifact.archive)
    await access(path)
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== artifact.archiveBytes) throw new Error(`Project Supabase image artifact ${service.name} archive size mismatch`)
    if (await sha256File(path) !== artifact.archiveSha256) throw new Error(`Project Supabase image artifact ${service.name} archive digest mismatch`)
  }
  return input
}

export async function readImageArtifactManifest(path, lock) {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  return validateImageArtifactManifest(manifest, lock, resolve(path, '..'))
}

