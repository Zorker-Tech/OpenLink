import { createHash, createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDockerEngine, resolveDockerCommand } from './lib/docker-runtime.mjs'
import { enableZokerbaseModernAuthCompose, generateZokerbaseModernAuth, generateZokerbaseSecrets } from './lib/zokerbase-auth.mjs'
import { hardenUserOnlySecret } from './lib/windows-security.mjs'
import { resolveHostPlatform, resolveUserStateRoot } from './lib/host-platform.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = resolve(root, 'backend/docker')
// ZOKERBASE is the product distribution. Supabase remains an implementation
// protocol/API dependency only, so it does not leak into the user-visible
// service identity, runtime path, container names, or image references.
const runtimeRoot = resolve(root, '.openlink-runtime/zokerbase')
const stackRoot = resolve(runtimeRoot, 'stack')
const hostPlatform = resolveHostPlatform()
const workspaceEnvPath = resolve(stackRoot, '.env')
const envPath = hostPlatform.platform === 'win32'
  ? resolve(resolveUserStateRoot(root, { host: hostPlatform }), 'zokerbase', '.env')
  : workspaceEnvPath
const manifestPath = resolve(runtimeRoot, 'manifest.json')
const imageArtifactRoot = resolve(runtimeRoot, 'images')
const imageArtifactManifestPath = resolve(imageArtifactRoot, 'manifest.json')
const legacyRuntimeRoot = resolve(root, '.openlink-runtime/local-supabase')
const legacyStackRoot = resolve(legacyRuntimeRoot, 'stack')
const legacyEnvPath = resolve(legacyStackRoot, '.env')
const apiPort = Number(process.env.OPENLINK_LOCAL_ZOKERBASE_API_PORT || process.env.OPENLINK_LOCAL_SUPABASE_API_PORT || 54380)
const postgresPort = Number(process.env.OPENLINK_LOCAL_ZOKERBASE_POSTGRES_PORT || process.env.OPENLINK_LOCAL_SUPABASE_POSTGRES_PORT || 54382)
const transactionPort = postgresPort + 1
const directPostgresPort = Number(process.env.OPENLINK_LOCAL_ZOKERBASE_DB_DIRECT_PORT || process.env.OPENLINK_LOCAL_SUPABASE_DB_DIRECT_PORT || 54384)
let dockerCommand

async function docker() {
  dockerCommand ||= await resolveDockerCommand()
  return dockerCommand
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...options.env },
      stdio: options.input === undefined
        ? (options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'])
        : ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    if (!options.inherit) {
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    }
    if (options.input !== undefined) child.stdin?.end(options.input)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveRun(stdout.trim())
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.trim().slice(-4000)}`))
    })
  })
}

function parseEnv(contents) {
  const result = new Map()
  for (const line of contents.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    result.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return result
}

function updateEnv(contents, replacements) {
  const pending = new Map(Object.entries(replacements).map(([key, value]) => [key, String(value)]))
  const lines = contents.split(/\r?\n/).map((line) => {
    const separator = line.indexOf('=')
    if (separator < 1 || line.trimStart().startsWith('#')) return line
    const key = line.slice(0, separator)
    if (!pending.has(key)) return line
    const value = pending.get(key)
    pending.delete(key)
    return `${key}=${value}`
  })
  for (const [key, value] of pending) lines.push(`${key}=${value}`)
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function legacyJwt(secret, role) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ role, iss: 'supabase', iat: now, exp: now + 5 * 365 * 24 * 3600 }))
  const data = `${header}.${payload}`
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`
}

async function syncRuntimeAssets() {
  await mkdir(stackRoot, { recursive: true, mode: 0o700 })
  await cp(sourceRoot, stackRoot, {
    recursive: true,
    force: true,
    filter(source) {
      const relative = source.slice(sourceRoot.length).replace(/^\//, '')
      return relative !== '.env' && !relative.startsWith('volumes/db/data') && !relative.startsWith('volumes/storage')
    },
  })
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function dockerVolumeExists(name) {
  try {
    await run(await docker(), ['volume', 'inspect', name])
    return true
  } catch {
    return false
  }
}

async function migrateNamedVolume(source, destination) {
  if (await dockerVolumeExists(destination)) return
  await run(await docker(), ['volume', 'create', destination])
  if (!(await dockerVolumeExists(source))) return
  await run(await docker(), [
    'run', '--rm', '--entrypoint', 'sh',
    '--volume', `${source}:/source:ro`,
    '--volume', `${destination}:/destination`,
    'zokerbase/postgres:2026.08.10',
    '-c', 'cp -a /source/. /destination/',
  ])
}

async function migrateLegacyLocalRuntime() {
  // The old local runtime used the same official topology under a
  // Supabase-branded state directory. Adopt it once so changing the product
  // distribution to ZOKERBASE never discards a user's local database, Auth
  // state, Storage files, or Studio configuration.
  if (await pathExists(envPath)) return undefined
  const sourceEnvPath = await pathExists(workspaceEnvPath)
    ? workspaceEnvPath
    : await pathExists(legacyEnvPath) ? legacyEnvPath : undefined
  if (!sourceEnvPath) return undefined

  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 })

  if (sourceEnvPath === legacyEnvPath) {
    await ensureDocker()
    await run(await docker(), [
      'compose', '--env-file', legacyEnvPath,
      '--file', 'docker-compose.yml', '--file', 'docker-compose.openlink.yml',
      'down', '--remove-orphans',
    ], { cwd: legacyStackRoot, inherit: true })

    // Postgres stores its pgsodium configuration in a Compose-managed named
    // volume rather than the bind-mounted data directory. Carry it forward as
    // well, otherwise an encrypted existing database can no longer be opened.
    await migrateNamedVolume('supabase_db-config', 'zokerbase_db-config')
  }

  await cp(sourceEnvPath, envPath, { force: false })
  if (sourceEnvPath === legacyEnvPath) {
    for (const relative of [
      'volumes/db/data',
      'volumes/db-config',
      'volumes/storage',
      'volumes/functions',
      'volumes/snippets',
    ]) {
      const source = resolve(legacyStackRoot, relative)
      const destination = resolve(stackRoot, relative)
      if (await pathExists(source)) await cp(source, destination, { recursive: true, force: false })
    }
  }
  return sourceEnvPath
}

async function ensureSecrets() {
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 })
  let fresh = false
  try {
    await stat(envPath)
  } catch {
    await cp(resolve(sourceRoot, '.env.example'), envPath)
    fresh = true
  }

  let contents = await readFile(envPath, 'utf8')
  if (fresh) contents = updateEnv(contents, generateZokerbaseSecrets())
  const current = parseEnv(contents)
  const jwtSecret = current.get('JWT_SECRET')
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('ZOKERBASE JWT secret must be at least 32 characters')
  const rotateKeys = !current.get('SUPABASE_PUBLISHABLE_KEY')
    || !current.get('SUPABASE_SECRET_KEY')
    || !current.get('JWT_KEYS')
    || !current.get('JWT_JWKS')
  const modernAuth = rotateKeys ? generateZokerbaseModernAuth(jwtSecret) : {}
  contents = updateEnv(contents, {
    JWT_SECRET: jwtSecret,
    ...(rotateKeys ? {
      ANON_KEY: legacyJwt(jwtSecret, 'anon'),
      SERVICE_ROLE_KEY: legacyJwt(jwtSecret, 'service_role'),
    } : {}),
    ...modernAuth,
    SUPABASE_PUBLIC_URL: `http://127.0.0.1:${apiPort}`,
    API_EXTERNAL_URL: `http://127.0.0.1:${apiPort}/auth/v1`,
    SITE_URL: process.env.OPENLINK_APP_URL || 'http://127.0.0.1:3000',
    ADDITIONAL_REDIRECT_URLS: [
      process.env.OPENLINK_APP_URL,
      'http://127.0.0.1:3000/**',
      'http://localhost:3000/**',
      'http://127.0.0.1:3002/**',
      'http://localhost:3002/**',
    ].filter(Boolean).join(','),
    POSTGRES_PORT: postgresPort,
    POOLER_PROXY_PORT_TRANSACTION: transactionPort,
    OPENLINK_DB_DIRECT_PORT: directPostgresPort,
    POOLER_TENANT_ID: 'zokerbase-local',
    KONG_HTTP_PORT: apiPort,
    KONG_HTTPS_PORT: apiPort + 1,
    PGRST_DB_SCHEMAS: 'openlink,public,graphql_public',
    PGRST_DB_EXTRA_SEARCH_PATH: 'openlink,public,extensions',
    DASHBOARD_USERNAME: 'zokerbase',
    STUDIO_DEFAULT_ORGANIZATION: 'ZOKERBASE Local',
    STUDIO_DEFAULT_PROJECT: 'ZOKERBASE',
    ENABLE_EMAIL_AUTOCONFIRM: 'true',
    OPENAI_API_KEY: '',
  })
  await writeFile(envPath, contents, { mode: 0o600 })
  const composePath = resolve(stackRoot, 'docker-compose.yml')
  const compose = await readFile(composePath, 'utf8')
  const enabledCompose = enableZokerbaseModernAuthCompose(compose)
  if (enabledCompose !== compose) await writeFile(composePath, enabledCompose)
  await hardenUserOnlySecret(envPath)
  const env = parseEnv(await readFile(envPath, 'utf8'))
  return { env }
}

async function ensureDocker() {
  dockerCommand = await ensureDockerEngine()
}

async function compose(args, options = {}) {
  return run(await docker(), ['compose', '--env-file', envPath, '--file', 'docker-compose.yml', '--file', 'docker-compose.openlink.yml', '--file', 'docker-compose.zokerbase.yml', ...args], {
    cwd: stackRoot,
    ...options,
  })
}

async function ensureZokerbaseImages() {
  const configuredImages = (await compose(['config', '--images'])).split(/\r?\n/).map((image) => image.trim()).filter(Boolean)
  const missing = []
  for (const image of configuredImages) {
    try {
      await run(await docker(), ['image', 'inspect', image])
    } catch {
      missing.push(image)
    }
  }
  if (missing.length === 0) return

  // A packaged ZOKERBASE release carries docker-save archives. Restore those
  // first so reinstalling or moving a product image never reaches an upstream
  // registry. Image production is only the first-install fallback when no
  // product artifact has been provided yet.
  try {
    const artifact = JSON.parse(await readFile(imageArtifactManifestPath, 'utf8'))
    if (artifact?.product === 'ZOKERBASE' && Array.isArray(artifact.images)) {
      for (const image of missing) {
        const entry = artifact.images.find((candidate) => candidate?.image === image)
        const archive = typeof entry?.archive === 'string' ? resolve(imageArtifactRoot, entry.archive) : undefined
        if (archive && await pathExists(archive)) await run(await docker(), ['load', '--input', archive])
      }
    }
  } catch {
    // No artifact exists yet: the controlled first-install producer below
    // creates it before the stack starts.
  }

  const unresolved = []
  for (const image of missing) {
    try {
      await run(await docker(), ['image', 'inspect', image])
    } catch {
      unresolved.push(image)
    }
  }
  if (unresolved.length === 0) return

  // A first start is allowed to produce the local ZOKERBASE artifact once.
  // Subsequent starts only inspect local images and compose uses --pull never,
  // so no service execution path resolves any upstream registry image.
  await run(process.execPath, ['scripts/build-zokerbase-images.mjs'], {
    cwd: root,
    inherit: true,
    env: { OPENLINK_SKIP_IMAGE_ARCHIVES: process.env.OPENLINK_BUILD_ARTIFACTS === '1' ? '0' : '1' },
  })
  for (const image of unresolved) {
    try {
      await run(await docker(), ['image', 'inspect', image])
    } catch {
      throw new Error(`ZOKERBASE image production completed without ${image}`)
    }
  }
}

async function waitForApi(url, publishableKey) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/auth/v1/health`, {
        headers: { apikey: publishableKey },
        signal: AbortSignal.timeout(3000),
      })
      if (response.ok) return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error('ZOKERBASE API did not become healthy within 180 seconds')
}

async function waitForContainerHealth(containerName, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await run(await docker(), [
        'inspect',
        '--format',
        '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
        containerName,
      ])
      const [status, health] = state.split('|')
      if (status === 'exited' || status === 'dead') throw new Error(`${containerName} exited while starting`)
      if (health === 'healthy' || (status === 'running' && !health)) return
    } catch (error) {
      if (error instanceof Error && error.message.includes('exited while starting')) throw error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error(`${containerName} did not become healthy within ${timeoutMs / 1000} seconds`)
}

async function composeUpWaitWithRetry(attempts = 6, delayMs = 5_000) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await compose(['up', '--detach', '--wait', '--pull', 'never'], { inherit: true })
      return
    } catch (error) {
      lastError = error
      if (attempt === attempts) throw error
      // `docker compose --wait` can report a dependent service unhealthy while
      // its HTTP endpoint is still inside its start_period. Retry the same
      // idempotent operation instead of making `npm run dev` fail permanently.
      process.stderr.write(`ZOKERBASE services are still becoming healthy; retrying (${attempt}/${attempts - 1})...\n`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
    }
  }
  throw lastError
}

async function psql(sql, { tuplesOnly = false } = {}) {
  // The ZOKERBASE Postgres image deliberately keeps the `postgres` role
  // non-superuser; `supabase_admin` owns the managed schemas and is the
  // migration role used by the self-hosted stack.
  const args = ['exec', '--interactive', 'zokerbase-db', 'psql', '--username', 'supabase_admin', '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1']
  if (tuplesOnly) args.push('--tuples-only', '--no-align')
  return run(await docker(), args, { input: sql })
}

async function applyMigrations() {
  await psql(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
    alter table supabase_migrations.schema_migrations add column if not exists statements text[];
    alter table supabase_migrations.schema_migrations add column if not exists name text;
  `)
  // ZOKERBASE owns the local migration namespace. Keep the legacy Supabase
  // path as a compatibility fallback for older checkouts, but prefer the
  // product-owned directory when it is present so a renamed distribution can
  // still bootstrap after a clean restart.
  const zokerbaseMigrationRoot = resolve(root, 'zorkerbase/migrations')
  const legacyMigrationRoot = resolve(root, 'supabase/migrations')
  const migrationRoot = await pathExists(zokerbaseMigrationRoot)
    ? zokerbaseMigrationRoot
    : legacyMigrationRoot
  const files = (await readdir(migrationRoot)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort()
  for (const file of files) {
    const [version, ...nameParts] = file.replace(/\.sql$/, '').split('_')
    const applied = await psql(`select 1 from supabase_migrations.schema_migrations where version = '${version}' limit 1;`, { tuplesOnly: true })
    if (applied.trim() === '1') continue
    const migration = await readFile(resolve(migrationRoot, file), 'utf8')
    const name = nameParts.join('_').replace(/'/g, "''")
    await psql(`begin;\n${migration}\ninsert into supabase_migrations.schema_migrations(version, name, statements) values ('${version}', '${name}', array[]::text[]);\ncommit;\n`)
  }
  await psql("notify pgrst, 'reload schema';")
}

export async function ensureZokerbase() {
  await syncRuntimeAssets()
  const migratedEnvPath = await migrateLegacyLocalRuntime()
  const { env } = await ensureSecrets()
  if (hostPlatform.platform === 'win32' && migratedEnvPath === workspaceEnvPath) {
    await rm(workspaceEnvPath)
  }
  await ensureDocker()
  // Compose treats the pgsodium key volume as external so it is never
  // re-created by an ordinary service restart. A brand-new install creates
  // the empty product-owned volume here; an adopted legacy install already
  // copied the old key into the same destination name.
  await migrateNamedVolume('supabase_db-config', 'zokerbase_db-config')
  await ensureZokerbaseImages()
  // Start the database and the official services without making PostgREST's
  // health gate block the process. OpenLink exposes the project schema in
  // PGRST_DB_SCHEMAS, but that schema is created by our migrations and is not
  // present in a brand-new Supabase volume yet.
  await compose(['up', '--detach', '--pull', 'never'], { inherit: true })
  await waitForContainerHealth('zokerbase-db')
  await psql(`
    create schema if not exists openlink;
    grant usage, create on schema openlink to supabase_admin, postgres, anon, authenticated, service_role;
    notify pgrst, 'reload schema';
  `)
  // PostgREST marks itself not-ready when its first schema-cache load fails;
  // a NOTIFY refreshes a live cache but does not clear that startup failure.
  // Restart the small REST container after the bootstrap schema exists so its
  // readiness probe is evaluated from a clean connection.
  await compose(['restart', 'rest'], { inherit: true })
  await composeUpWaitWithRetry()
  const url = `http://127.0.0.1:${apiPort}`
  const publishableKey = env.get('SUPABASE_PUBLISHABLE_KEY') || env.get('ANON_KEY')
  const secretKey = env.get('SUPABASE_SECRET_KEY') || env.get('SERVICE_ROLE_KEY')
  const password = env.get('POSTGRES_PASSWORD')
  if (!publishableKey || !secretKey || !password) throw new Error('ZOKERBASE generated credentials are incomplete')
  await waitForApi(url, publishableKey)
  await applyMigrations()
  const source = await readFile(resolve(root, 'backend/UPSTREAM.md'), 'utf8')
  const fingerprint = createHash('sha256').update(source).update(await readFile(resolve(sourceRoot, 'docker-compose.yml'))).digest('hex')
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 })
  await writeFile(manifestPath, `${JSON.stringify({ product: 'ZOKERBASE', identityMode: 'local', fingerprint, apiPort, postgresPort, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  return {
    url,
    publishableKey,
    secretKey,
    databaseUrl: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${directPostgresPort}/postgres`,
    studioUrl: `${url}`,
    identityMode: 'local',
  }
}

export async function stopZokerbase() {
  await ensureDocker()
  await compose(['down'])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'start'
  if (command === 'start') {
    const runtime = await ensureZokerbase()
    process.stdout.write(`${JSON.stringify({ product: 'ZOKERBASE', url: runtime.url, studioUrl: runtime.studioUrl, identityMode: runtime.identityMode })}\n`)
  } else if (command === 'stop') {
    await stopZokerbase()
  } else {
    throw new Error('Usage: node scripts/zokerbase.mjs [start|stop]')
  }
}
