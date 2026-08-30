import 'server-only'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const CODEX_TIMEOUT_MS = 15_000

type JsonRecord = Record<string, unknown>

interface RawPlugin {
  pluginId: string
  name: string
  marketplaceName: string
  version: string
  installed: boolean
  enabled: boolean
  installPolicy: string
  authPolicy: string
  sourcePath: string | null
}

export interface CodexPluginSkill {
  id: string
  name: string
  description: string
  source: 'builtin' | 'plugin'
  pluginId?: string
  defaultPrompt?: string
}

export interface CodexPlugin {
  pluginId: string
  name: string
  marketplaceName: string
  version: string
  installed: boolean
  enabled: boolean
  installPolicy: string
  authPolicy: string
  displayName: string
  shortDescription: string
  longDescription: string
  developerName: string
  category: string
  capabilities: string[]
  homepage: string | null
  repository: string | null
  license: string | null
  keywords: string[]
  websiteUrl: string | null
  privacyPolicyUrl: string | null
  termsOfServiceUrl: string | null
  defaultPrompts: string[]
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isInside(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !path.includes('../'))
}

async function runCodex(args: string[]) {
  const { stdout } = await execFileAsync('codex', args, {
    timeout: CODEX_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

async function rawPlugins(): Promise<RawPlugin[]> {
  const output = await runCodex(['plugin', 'list', '--available', '--json'])
  const parsed: unknown = JSON.parse(output)
  if (!isRecord(parsed)) throw new Error('CODEX_PLUGIN_CATALOG_INVALID')
  const candidates = [...(Array.isArray(parsed.installed) ? parsed.installed : []), ...(Array.isArray(parsed.available) ? parsed.available : [])]
  const seen = new Set<string>()
  return candidates.flatMap((item) => {
    if (!isRecord(item)) return []
    const pluginId = stringValue(item.pluginId)
    const name = stringValue(item.name)
    const marketplaceName = stringValue(item.marketplaceName)
    if (!pluginId || !name || !marketplaceName || seen.has(pluginId)) return []
    seen.add(pluginId)
    const source = isRecord(item.source) ? stringValue(item.source.path) : ''
    return [{
      pluginId,
      name,
      marketplaceName,
      version: stringValue(item.version),
      installed: item.installed === true,
      enabled: item.enabled === true,
      installPolicy: stringValue(item.installPolicy),
      authPolicy: stringValue(item.authPolicy),
      sourcePath: source && resolve(source) === source ? source : null,
    }]
  })
}

async function readManifest(sourcePath: string | null) {
  if (!sourcePath) return {} as JsonRecord
  const manifestPath = resolve(sourcePath, '.codex-plugin', 'plugin.json')
  if (!isInside(resolve(sourcePath), manifestPath)) return {} as JsonRecord
  try {
    const contents = await readFile(manifestPath, 'utf8')
    const parsed: unknown = JSON.parse(contents)
    return isRecord(parsed) ? parsed : {} as JsonRecord
  } catch {
    return {} as JsonRecord
  }
}

async function toPlugin(raw: RawPlugin): Promise<CodexPlugin> {
  const manifest = await readManifest(raw.sourcePath)
  const iface = isRecord(manifest.interface) ? manifest.interface : {}
  const author = isRecord(manifest.author) ? manifest.author : {}
  const displayName = stringValue(iface.displayName, raw.name)
  const shortDescription = stringValue(iface.shortDescription, stringValue(manifest.description))
  return {
    ...raw,
    displayName,
    shortDescription,
    longDescription: stringValue(iface.longDescription, shortDescription),
    developerName: stringValue(iface.developerName, stringValue(author.name)),
    category: stringValue(iface.category),
    capabilities: stringList(iface.capabilities),
    homepage: stringValue(manifest.homepage) || null,
    repository: stringValue(manifest.repository) || null,
    license: stringValue(manifest.license) || null,
    keywords: stringList(manifest.keywords),
    websiteUrl: stringValue(iface.websiteURL) || null,
    privacyPolicyUrl: stringValue(iface.privacyPolicyURL) || null,
    termsOfServiceUrl: stringValue(iface.termsOfServiceURL) || null,
    defaultPrompts: stringList(iface.defaultPrompt),
  }
}

export async function listCodexPlugins() {
  return Promise.all((await rawPlugins()).map(toPlugin))
}

function skillDetails(source: 'builtin' | 'plugin', id: string, content: string, pluginId?: string): CodexPluginSkill {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)?.[1] ?? ''
  const name = frontmatter.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || id
  const description = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()
    || content.replace(/^---[\s\S]*?---\s*/, '').split(/\n\s*\n/).find(Boolean)?.replace(/\s+/g, ' ').trim()
    || 'Codex skill'
  return { id: pluginId ? `${pluginId}:${id}` : id, name, description, source, pluginId }
}

async function skillsFromDirectory(directory: string, source: 'builtin' | 'plugin', pluginId?: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const results = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const file = resolve(directory, entry.name, 'SKILL.md')
      if (!isInside(resolve(directory), file)) return null
      try {
        const contents = await readFile(file, 'utf8')
        return skillDetails(source, entry.name, contents, pluginId)
      } catch {
        return null
      }
    }))
    return results.filter((skill): skill is CodexPluginSkill => Boolean(skill))
  } catch {
    return []
  }
}

export async function listCodexSkills() {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const builtin = await skillsFromDirectory(resolve(codexHome, 'skills'), 'builtin')
  const plugins = await Promise.all((await rawPlugins()).filter((plugin) => plugin.installed && plugin.sourcePath).map(async (plugin) => {
    const manifest = await readManifest(plugin.sourcePath)
    const skillPath = stringValue(manifest.skills)
    if (!skillPath || !plugin.sourcePath) return []
    const directory = resolve(plugin.sourcePath, skillPath)
    if (!isInside(resolve(plugin.sourcePath), directory)) return []
    try {
      if (!(await stat(directory)).isDirectory()) return []
      return skillsFromDirectory(directory, 'plugin', plugin.pluginId)
    } catch {
      return []
    }
  }))
  return [...builtin, ...plugins.flat()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function installCodexPlugin(pluginId: string) {
  const plugin = (await rawPlugins()).find((candidate) => candidate.pluginId === pluginId)
  if (!plugin) throw new Error('CODEX_PLUGIN_NOT_FOUND')
  if (plugin.installed) return
  if (plugin.installPolicy !== 'AVAILABLE') throw new Error('CODEX_PLUGIN_INSTALL_NOT_ALLOWED')
  // The selector is reconstructed from a catalog item returned by Codex, never
  // accepted from a request as a shell command or filesystem path.
  await runCodex(['plugin', 'add', `${plugin.name}@${plugin.marketplaceName}`])
}
