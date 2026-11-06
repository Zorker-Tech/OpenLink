import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_GATEWAY_PORT = 43126

const PROFILE_STORE_VERSION = 1
const KINDS = new Set(['cloud', 'remote'])

export function parseProfileUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A server URL is required')
  }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('The server URL is invalid')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The server URL must use HTTP or HTTPS')
  }
  if (url.username || url.password) {
    throw new Error('The server URL must not contain credentials')
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''))
}

export function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('A profile object is required')
  }
  const kind = String(input.kind || '')
  if (!KINDS.has(kind)) throw new Error('Profile kind must be cloud or remote')
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, 120)
    : kind === 'cloud'
      ? 'Cloud'
      : 'Remote'
  const profile = {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 120) : null,
    kind,
    name,
    upstreamUrl: parseProfileUrl(input.upstreamUrl),
    gatewayPort: Number.isInteger(input.gatewayPort) && input.gatewayPort > 0 && input.gatewayPort < 65_536
      ? input.gatewayPort
      : null,
  }
  return profile
}

function emptyStore() {
  return { version: PROFILE_STORE_VERSION, activeProfileId: null, profiles: [] }
}

export function createProfileStore({ filePath, defaultProfile = null }) {
  let store = emptyStore()

  async function persist() {
    await mkdir(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, filePath)
  }

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid profile store')
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.flatMap((item) => {
            try {
              return [{ ...validateProfile(item), id: item.id || randomUUID() }]
            } catch {
              return []
            }
          })
        : []
      store = {
        version: PROFILE_STORE_VERSION,
        activeProfileId: typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : null,
        profiles,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      store = emptyStore()
      if (defaultProfile) {
        const profile = { ...validateProfile(defaultProfile), id: defaultProfile.id || randomUUID() }
        store.profiles.push(profile)
        store.activeProfileId = profile.id
        await persist()
      }
    }
    if (store.activeProfileId && !store.profiles.some((profile) => profile.id === store.activeProfileId)) {
      store.activeProfileId = store.profiles[0]?.id ?? null
    }
    return snapshot()
  }

  function snapshot() {
    return {
      version: store.version,
      activeProfileId: store.activeProfileId,
      profiles: store.profiles.map((profile) => ({ ...profile })),
    }
  }

  async function upsert(input) {
    const profile = { ...validateProfile(input), id: input.id || randomUUID() }
    const index = store.profiles.findIndex((item) => item.id === profile.id)
    if (index >= 0) store.profiles[index] = profile
    else store.profiles.push(profile)
    // Activation is explicit. Auto-activating here would leave the persisted
    // active profile pointing at a server whose gateway was never started.
    await persist()
    return { ...profile }
  }

  async function remove(id) {
    const index = store.profiles.findIndex((profile) => profile.id === id)
    if (index < 0) return false
    store.profiles.splice(index, 1)
    if (store.activeProfileId === id) store.activeProfileId = store.profiles[0]?.id ?? null
    await persist()
    return true
  }

  async function setActive(id) {
    if (!store.profiles.some((profile) => profile.id === id)) {
      throw new Error('Profile was not found')
    }
    store.activeProfileId = id
    await persist()
    return snapshot()
  }

  function active() {
    return store.profiles.find((profile) => profile.id === store.activeProfileId) ?? null
  }

  function get(id) {
    return store.profiles.find((profile) => profile.id === id) ?? null
  }

  return {
    filePath,
    load,
    snapshot,
    list: () => store.profiles.map((profile) => ({ ...profile })),
    get,
    active,
    upsert,
    remove,
    setActive,
  }
}
