import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)
const SNAPSHOT_FORMAT_VERSION = 6
const SESSION_ROOT = '/openlink/session'
const RESERVED_REMOTE_MARKETPLACES = new Set([
  'openai-curated-remote',
  'created-by-me-remote',
  'workspace-directory',
  'workspace-shared-with-me',
  'workspace-shared-with-me-private',
  'workspace-shared-with-me-unlisted',
])

interface CodexPluginCatalogEntry {
  pluginId?: unknown
  name?: unknown
  marketplaceName?: unknown
  version?: unknown
  installed?: unknown
  enabled?: unknown
  source?: { source?: unknown; path?: unknown }
  installPolicy?: unknown
  authPolicy?: unknown
}

interface CodexPluginCatalog {
  installed?: unknown
}

interface SnapshotPlugin {
  pluginId: string
  name: string
  marketplaceName: string
  runtimePluginId: string
  runtimeMarketplaceName: string
  version: string
  sourcePath: string
  installPolicy: string
  authPolicy: string
  manifestDigest: string
}

export interface CodexPluginSnapshot {
  revision: string
  archivePath: string
  pluginIds: string[]
  warnings?: string[]
}

export interface CodexPluginSnapshotOptions {
  codexBin: string
  codexHome?: string
  cacheRoot: string
  refreshIntervalMs?: number
  loadCatalog?: () => Promise<unknown>
  onWarning?: (message: string) => void
}

export interface CodexPluginSnapshotProvider {
  (): Promise<CodexPluginSnapshot>
  /** Drop the host catalog cache after an explicit install or enablement change. */
  invalidate(): void
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Codex plugin ${label} is invalid: ${value}`)
  return value
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function marketplaceRelativeRoot(marketplaceName: string): string {
  if (marketplaceName === 'openai-curated' || marketplaceName === 'openai-api-curated') return 'codex-home/.tmp/plugins'
  if (marketplaceName === 'openai-bundled' || marketplaceName === 'openai-bundled-alpha') {
    return `codex-home/.tmp/bundled-marketplaces/${marketplaceName}`
  }
  if (marketplaceName === 'openai-primary-runtime') {
    return 'codex-cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime'
  }
  return `codex-home/openlink-marketplaces/${marketplaceName}`
}

function runtimeMarketplaceName(marketplaceName: string): string {
  // OpenLink starts Codex with a custom API provider and does not copy host
  // ChatGPT account credentials. Codex loads api_marketplace.json under the
  // native openai-api-curated identity in that authentication mode.
  if (marketplaceName === 'openai-curated') return 'openai-api-curated'
  // Native Codex reserves its remote marketplace identities for account-backed
  // discovery and silently rejects a configured local marketplace using one of
  // those names. The Project VM deliberately has no host account credentials,
  // so give the isolated, host-derived snapshot a non-reserved runtime identity.
  if (RESERVED_REMOTE_MARKETPLACES.has(marketplaceName)) return `openlink-${marketplaceName}`
  return marketplaceName
}

function marketplaceSessionRoot(marketplaceName: string): string {
  return `${SESSION_ROOT}/${marketplaceRelativeRoot(marketplaceName)}`
}

async function normalizeCatalog(catalog: unknown, codexHome: string, warn: (message: string) => void): Promise<SnapshotPlugin[]> {
  const record = catalog && typeof catalog === 'object' && !Array.isArray(catalog) ? catalog as CodexPluginCatalog : {}
  const installed = Array.isArray(record.installed) ? record.installed : []
  const plugins: SnapshotPlugin[] = []
  for (const value of installed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as CodexPluginCatalogEntry
    if (entry.installed !== true || entry.enabled !== true) continue
    const pluginId = typeof entry.pluginId === 'string' ? entry.pluginId : ''
    const name = typeof entry.name === 'string' ? entry.name : ''
    const marketplaceName = typeof entry.marketplaceName === 'string' ? entry.marketplaceName : ''
    const version = typeof entry.version === 'string' && entry.version ? entry.version : 'local'
    try {
      // Validate before joining a remote catalog identity into a local path.
      safeSegment(name, 'name')
      safeSegment(marketplaceName, 'marketplace')
      safeSegment(version, 'version')
      const sourcePath = entry.source?.source === 'local' && typeof entry.source.path === 'string'
        ? resolve(entry.source.path)
        : entry.source?.source === 'remote'
          ? join(codexHome, 'plugins', 'cache', marketplaceName, name, version)
          : ''
      if (!pluginId || pluginId !== `${name}@${marketplaceName}` || !sourcePath) {
        throw new Error(`Installed Codex plugin has no portable local source: ${pluginId || name || 'unknown'}`)
      }
      const runtimeMarketplace = runtimeMarketplaceName(marketplaceName)
      const manifestPath = join(sourcePath, '.codex-plugin', 'plugin.json')
      const manifest = await readFile(manifestPath)
      if (JSON.parse(manifest.toString('utf8')).name !== name) throw new Error('PLUGIN_MANIFEST_IDENTITY_MISMATCH')
      if (!(await stat(sourcePath)).isDirectory()) throw new Error(`Codex plugin source is not a directory: ${sourcePath}`)
      plugins.push({
        pluginId,
        name,
        marketplaceName,
        runtimePluginId: `${name}@${runtimeMarketplace}`,
        runtimeMarketplaceName: runtimeMarketplace,
        version,
        sourcePath,
        installPolicy: typeof entry.installPolicy === 'string' ? entry.installPolicy : 'AVAILABLE',
        authPolicy: typeof entry.authPolicy === 'string' ? entry.authPolicy : 'ON_USE',
        manifestDigest: createHash('sha256').update(manifest).digest('hex'),
      })
    } catch {
      // Connector catalog entries are not necessarily portable. Only copy
      // the installed plugin package, never host auth or connector secrets.
      warn(`Plugin ${JSON.stringify(pluginId || name).slice(0, 200)} omitted: no valid portable installed package`)
    }
  }
  return plugins.sort((left, right) => left.pluginId.localeCompare(right.pluginId))
}

function snapshotRevision(plugins: SnapshotPlugin[]): string {
  return createHash('sha256').update(JSON.stringify({
    format: SNAPSHOT_FORMAT_VERSION,
    plugins: plugins.map(({ pluginId, runtimePluginId, version, sourcePath, manifestDigest }) => ({ pluginId, runtimePluginId, version, sourcePath, manifestDigest })),
  })).digest('hex')
}

function configToml(plugins: SnapshotPlugin[]): string {
  const marketplaces = [...new Set(plugins.map((plugin) => plugin.runtimeMarketplaceName))]
    .filter((name) => name !== 'openai-api-curated')
    .sort()
  return [
    '[features]',
    'plugins = true',
    '',
    '[projects."/workspace"]',
    'trust_level = "trusted"',
    '',
    ...marketplaces.flatMap((name) => [
      `[marketplaces.${tomlString(name)}]`,
      'source_type = "local"',
      `source = ${tomlString(marketplaceSessionRoot(name))}`,
      '',
    ]),
    ...plugins.flatMap((plugin) => [
      `[plugins.${tomlString(plugin.runtimePluginId)}]`,
      'enabled = true',
      '',
    ]),
  ].join('\n')
}

async function buildSnapshot(cacheRoot: string, plugins: SnapshotPlugin[], revision: string): Promise<CodexPluginSnapshot> {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const archivePath = join(cacheRoot, `${revision}.tar.gz`)
  try {
    if ((await stat(archivePath)).isFile()) return { revision, archivePath, pluginIds: plugins.map((plugin) => plugin.runtimePluginId) }
  } catch {}

  const staging = await mkdtemp(join(cacheRoot, '.staging-'))
  const temporaryArchive = join(cacheRoot, `.${revision}.${process.pid}.tar.gz`)
  try {
    await mkdir(join(staging, 'codex-home'), { recursive: true, mode: 0o700 })
    await writeFile(join(staging, 'codex-home', 'config.toml'), configToml(plugins), { encoding: 'utf8', mode: 0o600 })

    const byMarketplace = new Map<string, SnapshotPlugin[]>()
    for (const plugin of plugins) {
      const values = byMarketplace.get(plugin.runtimeMarketplaceName) ?? []
      values.push(plugin)
      byMarketplace.set(plugin.runtimeMarketplaceName, values)
      const cacheDestination = join(staging, 'codex-home', 'plugins', 'cache', plugin.runtimeMarketplaceName, plugin.name, plugin.version)
      await mkdir(join(cacheDestination, '..'), { recursive: true, mode: 0o700 })
      await cp(plugin.sourcePath, cacheDestination, { recursive: true, dereference: true, force: true })
    }

    for (const [marketplaceName, marketplacePlugins] of byMarketplace) {
      const marketplaceRoot = join(staging, marketplaceRelativeRoot(marketplaceName))
      const marketplacePluginsRoot = join(marketplaceRoot, 'plugins')
      const manifestRoot = join(marketplaceRoot, '.agents', 'plugins')
      await mkdir(marketplacePluginsRoot, { recursive: true, mode: 0o700 })
      await mkdir(manifestRoot, { recursive: true, mode: 0o700 })
      if (marketplaceName === 'openai-api-curated') await mkdir(join(marketplaceRoot, '.git'), { recursive: true, mode: 0o700 })
      for (const plugin of marketplacePlugins) {
        const cacheDestination = join(staging, 'codex-home', 'plugins', 'cache', plugin.runtimeMarketplaceName, plugin.name, plugin.version)
        const linkPath = join(marketplacePluginsRoot, plugin.name)
        await symlink(relative(marketplacePluginsRoot, cacheDestination), linkPath, 'dir')
      }
      const manifestContents = `${JSON.stringify({
        name: marketplaceName,
        plugins: marketplacePlugins.map((plugin) => ({
          name: plugin.name,
          source: { source: 'local', path: `./plugins/${plugin.name}` },
          policy: { installation: plugin.installPolicy, authentication: plugin.authPolicy },
        })),
      }, null, 2)}\n`
      await writeFile(join(manifestRoot, marketplaceName === 'openai-api-curated' ? 'api_marketplace.json' : 'marketplace.json'), manifestContents, { encoding: 'utf8', mode: 0o600 })
      if (marketplaceName === 'openai-api-curated') {
        // Codex refreshes its curated Git checkout asynchronously at startup.
        // Keep the host-derived API view outside that mutable checkout so the
        // Worker can project it back immediately before native resource reads.
        const projectionRoot = join(staging, 'codex-home', 'openlink-native')
        await mkdir(projectionRoot, { recursive: true, mode: 0o700 })
        await writeFile(join(projectionRoot, 'api_marketplace.json'), manifestContents, { encoding: 'utf8', mode: 0o600 })
        await writeFile(join(staging, 'codex-home', '.tmp', 'plugins.sha'), `${revision}\n`, { encoding: 'utf8', mode: 0o600 })
      }
    }

    await execFileAsync('tar', ['-czf', temporaryArchive, '-C', staging, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      maxBuffer: 4 * 1024 * 1024,
    })
    await rename(temporaryArchive, archivePath)
    return { revision, archivePath, pluginIds: plugins.map((plugin) => plugin.runtimePluginId) }
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(temporaryArchive, { force: true })
  }
}

export function createCodexPluginSnapshotProvider(options: CodexPluginSnapshotOptions): CodexPluginSnapshotProvider {
  let cached: { expiresAt: number; value: Promise<CodexPluginSnapshot> } | undefined
  let inFlight: Promise<CodexPluginSnapshot> | undefined
  let generation = 0
  const refreshIntervalMs = options.refreshIntervalMs ?? 5_000
  const codexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'))
  const provider = async () => {
    if (inFlight) return inFlight
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const requestGeneration = generation
    const value = (async () => {
      const warnings: string[] = []
      const warn = (message: string) => {
        warnings.push(message)
        if (options.onWarning) options.onWarning(message)
        else console.warn(`OpenLink Codex plugins: ${message}`)
      }
      try {
        const catalog = options.loadCatalog
          ? await options.loadCatalog()
          : JSON.parse((await execFileAsync(options.codexBin, ['plugin', 'list', '--available', '--json'], {
              env: { ...process.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) },
              maxBuffer: 16 * 1024 * 1024,
              timeout: 10_000,
            })).stdout)
        const plugins = await normalizeCatalog(catalog, codexHome, warn)
        const revision = snapshotRevision(plugins)
        return { ...await buildSnapshot(resolve(options.cacheRoot), plugins, revision), warnings }
      } catch {
        // Optional host plugins cannot make the native Agent unavailable.
        // Do not reuse a stale catalog that may contain disabled plugins.
        warn('Host plugin snapshot unavailable; continuing without host plugins')
        return { ...await buildSnapshot(resolve(options.cacheRoot), [], snapshotRevision([])), warnings }
      }
    })()
    inFlight = value
    try {
      const result = await value
      if (requestGeneration === generation) cached = { expiresAt: Date.now() + refreshIntervalMs, value: Promise.resolve(result) }
      return result
    } catch (error) {
      if (cached?.value === value) cached = undefined
      throw error
    } finally {
      if (inFlight === value) inFlight = undefined
    }
  }
  provider.invalidate = () => {
    generation += 1
    cached = undefined
    // An already-running read cannot be cancelled, but it must not block or
    // repopulate the cache for the post-install generation.
    inFlight = undefined
  }
  return provider
}
