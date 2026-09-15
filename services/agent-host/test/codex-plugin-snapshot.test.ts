import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { promisify } from 'node:util'
import { createCodexPluginSnapshotProvider } from '../src/codex-plugin-snapshot.js'

const execFileAsync = promisify(execFile)

test('builds an isolated Codex home from installed and enabled host plugins', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-codex-plugin-snapshot-'))
  context.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const pluginSource = join(root, 'source', 'browser')
  await mkdir(join(pluginSource, '.codex-plugin'), { recursive: true })
  await mkdir(join(pluginSource, 'skills', 'control-in-app-browser'), { recursive: true })
  await writeFile(join(pluginSource, '.codex-plugin', 'plugin.json'), '{"name":"browser"}\n')
  await writeFile(join(pluginSource, 'skills', 'control-in-app-browser', 'SKILL.md'), 'browser skill\n')
  const curatedPluginSource = join(root, 'source', 'chatcut')
  await mkdir(join(curatedPluginSource, '.codex-plugin'), { recursive: true })
  await writeFile(join(curatedPluginSource, '.codex-plugin', 'plugin.json'), '{"name":"chatcut"}\n')

  let catalogLoads = 0
  const provider = createCodexPluginSnapshotProvider({
    codexBin: 'unused',
    cacheRoot: join(root, 'snapshots'),
    refreshIntervalMs: 60_000,
    loadCatalog: async () => {
      catalogLoads += 1
      return {
        installed: [{
          pluginId: 'browser@openai-bundled',
          name: 'browser',
          marketplaceName: 'openai-bundled',
          version: '1.2.3',
          installed: true,
          enabled: true,
          source: { source: 'local', path: pluginSource },
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
        }, {
          pluginId: 'chatcut@openai-curated',
          name: 'chatcut',
          marketplaceName: 'openai-curated',
          version: 'abcdef12',
          installed: true,
          enabled: true,
          source: { source: 'local', path: curatedPluginSource },
        }, {
          pluginId: 'disabled@openai-bundled',
          name: 'disabled',
          marketplaceName: 'openai-bundled',
          version: '1.0.0',
          installed: true,
          enabled: false,
          source: { source: 'local', path: pluginSource },
        }],
      }
    },
  })

  const first = await provider()
  const second = await provider()
  assert.equal(second.revision, first.revision)
  assert.equal(catalogLoads, 1)
  assert.deepEqual(first.pluginIds, ['browser@openai-bundled', 'chatcut@openai-api-curated'])

  const extracted = join(root, 'extracted')
  await mkdir(extracted)
  await execFileAsync('tar', ['-xzf', first.archivePath, '-C', extracted])
  const config = await readFile(join(extracted, 'codex-home', 'config.toml'), 'utf8')
  assert.match(config, /\[features\]\nplugins = true/)
  assert.match(config, /\[plugins\."browser@openai-bundled"\]\nenabled = true/)
  assert.match(config, /\[plugins\."chatcut@openai-api-curated"\]\nenabled = true/)
  assert.doesNotMatch(config, /disabled@openai-bundled/)
  assert.match(config, /source = "\/openlink\/session\/codex-home\/\.tmp\/bundled-marketplaces\/openai-bundled"/)

  const installedSkill = join(extracted, 'codex-home', 'plugins', 'cache', 'openai-bundled', 'browser', '1.2.3', 'skills', 'control-in-app-browser', 'SKILL.md')
  assert.equal(await readFile(installedSkill, 'utf8'), 'browser skill\n')
  const marketplacePlugin = join(extracted, 'codex-home', '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins', 'browser')
  assert.equal(await realpath(marketplacePlugin), await realpath(join(extracted, 'codex-home', 'plugins', 'cache', 'openai-bundled', 'browser', '1.2.3')))
  const marketplace = JSON.parse(await readFile(join(extracted, 'codex-home', '.tmp', 'bundled-marketplaces', 'openai-bundled', '.agents', 'plugins', 'marketplace.json'), 'utf8'))
  assert.equal(marketplace.name, 'openai-bundled')
  assert.equal(marketplace.plugins[0].source.path, './plugins/browser')
  const apiCurated = JSON.parse(await readFile(join(extracted, 'codex-home', '.tmp', 'plugins', '.agents', 'plugins', 'api_marketplace.json'), 'utf8'))
  assert.equal(apiCurated.name, 'openai-api-curated')
  assert.equal(apiCurated.plugins[0].name, 'chatcut')
  const apiProjection = JSON.parse(await readFile(join(extracted, 'codex-home', 'openlink-native', 'api_marketplace.json'), 'utf8'))
  assert.deepEqual(apiProjection, apiCurated)
  assert.equal(await readFile(join(extracted, 'codex-home', 'plugins', 'cache', 'openai-api-curated', 'chatcut', 'abcdef12', '.codex-plugin', 'plugin.json'), 'utf8'), '{"name":"chatcut"}\n')
  assert.ok((await readFile(join(extracted, 'codex-home', '.tmp', 'plugins.sha'), 'utf8')).trim().length > 0)
})

test('isolates unsafe catalog identities without blocking the native Agent', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-codex-plugin-invalid-'))
  context.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  const provider = createCodexPluginSnapshotProvider({
    codexBin: 'unused',
    cacheRoot: join(root, 'snapshots'),
    loadCatalog: async () => ({
      installed: [{
        pluginId: '../escape@market',
        name: '../escape',
        marketplaceName: 'market',
        version: 'local',
        installed: true,
        enabled: true,
        source: { source: 'local', path: root },
      }],
    }),
  })
  const snapshot = await provider()
  assert.deepEqual(snapshot.pluginIds, [])
  assert.match(snapshot.warnings?.[0] ?? '', /omitted/)
})

test('remote plugins use only the exact installed cache version and isolate missing packages', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-plugin-remote-'))
  context.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  const home = join(root, 'home')
  const source = join(home, 'plugins', 'cache', 'remote-market', 'github', '1.0.0')
  await mkdir(join(source, '.codex-plugin'), { recursive: true })
  await writeFile(join(source, '.codex-plugin', 'plugin.json'), '{"name":"github"}')
  await writeFile(join(home, 'auth.json'), 'HOST_SECRET_MUST_NOT_COPY')
  const entry = (name: string, version: string) => ({
    pluginId: `${name}@remote-market`, name, version, marketplaceName: 'remote-market',
    installed: true, enabled: true, source: { source: 'remote', id: 'connector-id' },
  })
  const provider = createCodexPluginSnapshotProvider({
    codexBin: 'unused', codexHome: home, cacheRoot: join(root, 'snapshots'),
    loadCatalog: async () => ({ installed: [entry('github', '1.0.0'), entry('missing', '2.0.0')] }),
  })
  const result = await provider()
  assert.deepEqual(result.pluginIds, ['github@remote-market'])
  assert.equal(result.warnings?.length, 1)
  const listing = (await execFileAsync('tar', ['-tzf', result.archivePath])).stdout
  assert.match(listing, /remote-market\/github\/1.0.0\/.codex-plugin\/plugin.json/)
  assert.doesNotMatch(listing, /auth.json/)
})

test('projects reserved remote marketplaces into loadable isolated runtime identities', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-plugin-reserved-remote-'))
  context.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  const home = join(root, 'home')
  const source = join(home, 'plugins', 'cache', 'openai-curated-remote', '12ui-design', '0.2.65')
  await mkdir(join(source, '.codex-plugin'), { recursive: true })
  await writeFile(join(source, '.codex-plugin', 'plugin.json'), '{"name":"12ui-design"}')
  const provider = createCodexPluginSnapshotProvider({
    codexBin: 'unused', codexHome: home, cacheRoot: join(root, 'snapshots'),
    loadCatalog: async () => ({ installed: [{
      pluginId: '12ui-design@openai-curated-remote',
      name: '12ui-design',
      version: '0.2.65',
      marketplaceName: 'openai-curated-remote',
      installed: true,
      enabled: true,
      source: { source: 'remote', id: 'remote-plugin-id' },
    }] }),
  })

  const result = await provider()
  assert.deepEqual(result.pluginIds, ['12ui-design@openlink-openai-curated-remote'])
  const extracted = join(root, 'extracted')
  await mkdir(extracted)
  await execFileAsync('tar', ['-xzf', result.archivePath, '-C', extracted])
  const config = await readFile(join(extracted, 'codex-home', 'config.toml'), 'utf8')
  assert.match(config, /\[marketplaces\."openlink-openai-curated-remote"\]/)
  assert.match(config, /\[plugins\."12ui-design@openlink-openai-curated-remote"\]/)
  assert.doesNotMatch(config, /\[marketplaces\."openai-curated-remote"\]/)
  const marketplace = JSON.parse(await readFile(join(extracted, 'codex-home', 'openlink-marketplaces', 'openlink-openai-curated-remote', '.agents', 'plugins', 'marketplace.json'), 'utf8'))
  assert.equal(marketplace.name, 'openlink-openai-curated-remote')
  assert.equal(marketplace.plugins[0].name, '12ui-design')
})

test('catalog failures degrade to an explicit empty snapshot and later recover', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-plugin-failure-'))
  context.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  let calls = 0
  const provider = createCodexPluginSnapshotProvider({
    codexBin: 'unused', cacheRoot: root, refreshIntervalMs: 0,
    loadCatalog: async () => { if (++calls === 1) throw new Error('private diagnostic'); return { installed: [] } },
  })
  const first = await provider()
  assert.deepEqual(first.pluginIds, [])
  assert.match(first.warnings?.[0] ?? '', /continuing without host plugins/)
  assert.doesNotMatch(JSON.stringify(first.warnings), /private diagnostic/)
  const second = await provider()
  assert.deepEqual(second.warnings, [])
})

test('concurrent refreshes share an in-flight snapshot even past the refresh interval', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-plugin-inflight-'))
  context.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const provider = createCodexPluginSnapshotProvider({
    codexBin: 'unused', cacheRoot: root, refreshIntervalMs: 0,
    loadCatalog: async () => { calls++; await gate; return { installed: [] } },
  })
  const first = provider()
  const second = provider()
  release()
  assert.equal((await first).revision, (await second).revision)
  assert.equal(calls, 1)
})

test('explicit invalidation cannot reuse or recache the pre-install catalog generation', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openlink-plugin-invalidate-'))
  context.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }) })
  let calls = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const provider = createCodexPluginSnapshotProvider({
    codexBin: 'unused', cacheRoot: root, refreshIntervalMs: 60_000,
    loadCatalog: async () => {
      calls += 1
      if (calls === 1) await firstGate
      return { installed: [] }
    },
  })
  const stale = provider()
  provider.invalidate()
  const fresh = provider()
  releaseFirst()
  await Promise.all([stale, fresh])
  await provider()
  assert.equal(calls, 2)
})
