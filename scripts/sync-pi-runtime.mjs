import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceRevision } from './lib/monorepo-sources.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const piRoot = join(root, 'services/pi')
const runtimeRoot = join(root, 'packages/pi-runtime')
const tarballRoot = join(runtimeRoot, 'tarballs')
const manifestPath = join(runtimeRoot, 'manifest.json')
const generatedSources = [
  'packages/ai/src/models.generated.ts',
  'packages/ai/src/image-models.generated.ts',
  'packages/ai/src/providers/data',
]
const packages = [
  { name: '@earendil-works/pi-ai', output: 'pi-ai.tgz' },
  { name: '@earendil-works/pi-tui', output: 'pi-tui.tgz' },
  { name: '@earendil-works/pi-agent-core', output: 'pi-agent-core.tgz' },
  { name: '@earendil-works/pi-protocol', output: 'pi-protocol.tgz' },
  { name: '@earendil-works/pi-client', output: 'pi-client.tgz' },
  { name: '@earendil-works/pi-coding-agent', output: 'pi-coding-agent.tgz' },
]

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '1',
      npm_config_registry: process.env.OPENLINK_NPM_REGISTRY || 'https://registry.npmjs.org',
      PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`,
    },
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function currentIdentity() {
  const packageJson = readJson(join(piRoot, 'packages/coding-agent/package.json'))
  return {
    // The service is vendored into the root repository. Its upstream identity
    // is recorded explicitly instead of reading the root monorepo HEAD.
    commit: sourceRevision('pi'),
    version: packageJson.version,
  }
}

function validateManifest(identity) {
  if (!existsSync(manifestPath)) return false
  const manifest = readJson(manifestPath)
  if (manifest.piCommit !== identity.commit || manifest.piVersion !== identity.version) return false
  return packages.every(({ name, output }) => {
    const path = join(tarballRoot, output)
    return existsSync(path) && manifest.packages?.[name]?.file === output && manifest.packages[name].sha256 === sha256(path)
  })
}

function snapshotGeneratedSources(backupRoot) {
  const snapshots = []
  for (const relativePath of generatedSources) {
    const source = join(piRoot, relativePath)
    const backup = join(backupRoot, relativePath)
    const existed = existsSync(source)
    if (existed) {
      mkdirSync(dirname(backup), { recursive: true })
      cpSync(source, backup, { recursive: true })
    }
    snapshots.push({ backup, existed, source })
  }
  return snapshots
}

function restoreGeneratedSources(snapshots) {
  for (const { backup, existed, source } of snapshots) {
    rmSync(source, { force: true, recursive: true })
    if (existed) {
      mkdirSync(dirname(source), { recursive: true })
      cpSync(backup, source, { recursive: true })
    }
  }
}

function packageNameFromTarball(path) {
  const packageJson = JSON.parse(command('tar', ['-xOf', path, 'package/package.json'], { capture: true }))
  return packageJson.name
}

const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--check' && arg !== '--force')) {
  throw new Error('Usage: node scripts/sync-pi-runtime.mjs [--check] [--force]')
}
const checkOnly = args.includes('--check')
const force = args.includes('--force')
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
  throw new Error(`Pi runtime packaging requires Node >=22.19.0; current ${process.version}`)
}

const identity = currentIdentity()
if (!force && validateManifest(identity)) {
  process.stdout.write(`Pi runtime is current at ${identity.commit.slice(0, 12)} (${identity.version}).\n`)
  process.exit(0)
}
if (checkOnly) throw new Error('Pi runtime artifacts are missing, modified, or stale; run npm run agent:sync-pi')

const buildRoot = mkdtempSync(join(tmpdir(), 'openlink-pi-runtime-'))
const snapshots = snapshotGeneratedSources(join(buildRoot, 'source-backup'))

try {
  command('npm', [
    'run',
    'release:local',
    '--',
    '--out',
    join(buildRoot, 'release'),
    '--force',
    '--skip-check',
    '--skip-test',
    '--skip-install',
  ], { cwd: piRoot })

  const packedRoot = join(buildRoot, 'release/tarballs')
  const discovered = new Map()
  const files = command('find', [packedRoot, '-maxdepth', '1', '-type', 'f', '-name', '*.tgz'], { capture: true })
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const file of files) discovered.set(packageNameFromTarball(file), file)

  mkdirSync(tarballRoot, { recursive: true })
  const manifestPackages = {}
  for (const { name, output } of packages) {
    const source = discovered.get(name)
    if (!source) throw new Error(`Pi release did not produce ${name}`)
    const target = join(tarballRoot, output)
    cpSync(source, target)
    manifestPackages[name] = {
      file: basename(target),
      sha256: sha256(target),
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    piCommit: identity.commit,
    piVersion: identity.version,
    packages: manifestPackages,
  }, null, 2)}\n`)
  process.stdout.write(`Synced Pi ${identity.version} from ${identity.commit.slice(0, 12)}.\n`)
} finally {
  restoreGeneratedSources(snapshots)
  rmSync(buildRoot, { force: true, recursive: true })
}
