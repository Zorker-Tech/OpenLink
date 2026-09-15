import { createHmac, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parseEnvironmentFile } from './preflight.mjs'
import { profileEnvironment, resolveDeploymentProfile, resolveProjectRuntime } from './deployment-profile.mjs'
import { durableWriteFile, syncFile } from './durable-fs.mjs'

function token(bytes = 48) { return randomBytes(bytes).toString('base64url') }

function jwt(secret, role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ role, iss: 'zokerbase', iat: Math.floor(Date.now() / 1000), exp: 4_102_444_800 })).toString('base64url')
  const body = `${header}.${payload}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

function serialize(environment, comments = []) {
  return `${comments.map((line) => `# ${line}`).join('\n')}\n${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n')}\n`
}

function safeHttpsUrl(value, allowInsecure) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) throw new Error('Deployment URL must be a clean origin')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Deployment URL must not contain a path')
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) throw new Error('Production deployment URL must use HTTPS')
  return url.origin
}

export async function createProductionConfiguration(options = {}) {
  const releaseRoot = resolve(options.releaseRoot)
  const configPath = resolve(options.configPath)
  const secretsPath = resolve(options.secretsPath ?? join(dirname(configPath), 'secrets.env'))
  const backupKeyPath = resolve(options.backupKeyPath ?? join(dirname(configPath), 'backup.key'))
  const trustPath = resolve(options.trustPath ?? join(dirname(configPath), 'release-keys.json'))
  const stateRoot = resolve(options.stateRoot)
  const appUrl = safeHttpsUrl(options.appUrl, options.allowInsecure === true)
  const gatewayUrl = safeHttpsUrl(options.gatewayUrl ?? appUrl, options.allowInsecure === true)
  const parsedAppUrl = new URL(appUrl)
  const deploymentProfile = resolveDeploymentProfile(options.deploymentProfile)
  const projectRuntime = resolveProjectRuntime(options.projectRuntime)
  const profile = profileEnvironment(deploymentProfile.name, projectRuntime)
  const template = parseEnvironmentFile(await readFile(join(releaseRoot, 'orchestration/backend/docker/.env.example'), 'utf8'))
  const jwtSecret = token(48)
  const postgresPassword = token(36)
  const anonKey = jwt(jwtSecret, 'anon')
  const serviceRoleKey = jwt(jwtSecret, 'service_role')
  const zokerbase = {
    ...template,
    POSTGRES_PASSWORD: postgresPassword,
    JWT_SECRET: jwtSecret,
    ANON_KEY: anonKey,
    SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_PUBLISHABLE_KEY: anonKey,
    SUPABASE_SECRET_KEY: serviceRoleKey,
    JWT_KEYS: '[]',
    JWT_JWKS: '{"keys":[]}',
    DASHBOARD_USERNAME: 'openlink-admin',
    DASHBOARD_PASSWORD: token(32),
    SECRET_KEY_BASE: token(64),
    REALTIME_DB_ENC_KEY: randomBytes(8).toString('hex'),
    VAULT_ENC_KEY: randomBytes(16).toString('hex'),
    PG_META_CRYPTO_KEY: token(32),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: token(32),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: token(32),
    S3_PROTOCOL_ACCESS_KEY_ID: randomBytes(16).toString('hex'),
    S3_PROTOCOL_ACCESS_KEY_SECRET: randomBytes(32).toString('hex'),
    POOLER_TENANT_ID: token(16),
    MINIO_ROOT_PASSWORD: token(32),
    SUPABASE_PUBLIC_URL: appUrl,
    API_EXTERNAL_URL: `${appUrl}/auth/v1`,
    SITE_URL: appUrl,
    ADDITIONAL_REDIRECT_URLS: `${appUrl}/**`,
    PROXY_DOMAIN: new URL(appUrl).hostname,
    OPENLINK_DB_DIRECT_PORT: '54384',
    POSTGRES_PORT: '54384',
  }
  const config = {
    ...profile,
    OPENLINK_RUNTIME_MODE: 'local',
    OPENLINK_APP_URL: appUrl,
    OPENLINK_EDGE_ADDRESS: `${parsedAppUrl.protocol === 'http:' ? 'http://' : ''}${parsedAppUrl.host}`,
    OPENLINK_BROWSER_GATEWAY_PUBLIC_URL: gatewayUrl,
    OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS: appUrl,
    OPENLINK_STATE_ROOT: stateRoot,
    OPENLINK_LOG_ROOT: resolve(options.logRoot ?? join(stateRoot, 'logs')),
    OPENLINK_BACKUP_ROOT: resolve(options.backupRoot ?? join(dirname(stateRoot), 'backups')),
    OPENLINK_BACKUP_KEY_FILE: backupKeyPath,
    OPENLINK_RELEASE_TRUST_FILE: trustPath,
    OPENLINK_SECRETS_FILE: secretsPath,
    OPENLINK_ZOKERBASE_ENV_FILE: secretsPath,
    ...(process.platform === 'linux' ? {
      OPENLINK_CONTAINER_BROKER_SOCKET: '/run/openlink-container-broker/control.sock',
      OPENLINK_PROJECT_CONTAINER_BROKER_SOCKET: '/run/openlink-project-container-broker/control.sock',
    } : {}),
    OPENLINK_AGENT_MAX_SESSIONS: String(options.maxSessions ?? 32),
    OPENLINK_PROJECT_VM_CPUS: String(options.vmCpus ?? deploymentProfile.project.cpus),
    OPENLINK_PROJECT_VM_MEMORY_MB: String(options.vmMemoryMb ?? deploymentProfile.project.memoryMb),
    OPENLINK_PROJECT_VM_DISK_GB: String(options.vmDiskGb ?? deploymentProfile.project.diskGb),
    OPENLINK_MINIMUM_LOGICAL_CPUS: String(options.minimumLogicalCpus ?? deploymentProfile.host.logicalCpus),
    OPENLINK_MINIMUM_MEMORY_BYTES: String(options.minimumMemoryBytes ?? deploymentProfile.host.memoryBytes),
    OPENLINK_MINIMUM_FREE_BYTES: String(options.minimumFreeBytes ?? deploymentProfile.host.freeBytes),
    ...(options.allowInsecure ? { OPENLINK_ALLOW_INSECURE_HTTP: '1' } : {}),
  }
  const secrets = {
    ...zokerbase,
    OPENLINK_BROWSER_API_TOKEN: token(),
    OPENLINK_BROWSER_TOKEN_SECRET: token(),
    OPENLINK_AGENT_API_TOKEN: token(),
    OPENLINK_DESKTOP_AGENT_API_TOKEN: token(),
    OPENLINK_PROVIDER_SECRET_KEY: randomBytes(32).toString('base64url'),
    OPEN_SANDBOX_API_KEY: token(),
    OPENSANDBOX_SERVER_API_KEY: token(),
    OPENLINK_KNOWLEDGE_INTERNAL_TOKEN: token(),
    OPENLINK_LOCAL_ZOKERBASE_URL: appUrl,
    OPENLINK_LOCAL_ZOKERBASE_PUBLISHABLE_KEY: anonKey,
    OPENLINK_LOCAL_ZOKERBASE_SECRET_KEY: serviceRoleKey,
    OPENLINK_LOCAL_ZOKERBASE_DATABASE_URL: `postgresql://postgres:${postgresPassword}@127.0.0.1:54384/postgres`,
    OPENLINK_LOCAL_SUPABASE_URL: appUrl,
    OPENLINK_LOCAL_SUPABASE_PUBLISHABLE_KEY: anonKey,
    OPENLINK_LOCAL_SUPABASE_SECRET_KEY: serviceRoleKey,
    OPENLINK_LOCAL_DATABASE_URL: `postgresql://postgres:${postgresPassword}@127.0.0.1:54384/postgres`,
    OPENLINK_SUPABASE_URL: 'http://127.0.0.1:8000',
    OPENLINK_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    OPENLINK_KNOWLEDGE_ZOKERBASE_URL: 'http://127.0.0.1:8000',
    OPENLINK_KNOWLEDGE_ZOKERBASE_SERVICE_KEY: serviceRoleKey,
    NEXT_PUBLIC_SUPABASE_URL: appUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
  }
  await mkdir(dirname(configPath), { recursive: true, mode: 0o750 })
  // Linux service processes use distinct UIDs and need search permission on
  // the state root to reach their own 0700 subdirectories.
  await mkdir(stateRoot, { recursive: true, mode: process.platform === 'linux' ? 0o711 : 0o700 })
  const outputs = [configPath, secretsPath, backupKeyPath]
  for (const path of outputs) {
    if (await lstat(path).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) {
      throw new Error(`Production configuration already exists: ${path}`)
    }
  }
  const created = []
  try {
    // Never rotate a live database password, JWT root, or backup key as a side
    // effect of re-running configuration. Explicit rotation is a separate,
    // coordinated operation with its own rollback procedure.
    await durableWriteFile(configPath, serialize(config, ['Generated by openlinkctl configure.', 'Contains no secret values.']), { mode: 0o640, flag: 'wx' }); created.push(configPath)
    await durableWriteFile(secretsPath, serialize(secrets, ['Generated secret material. Do not copy into logs or source control.']), { mode: 0o600, flag: 'wx' }); created.push(secretsPath)
    await durableWriteFile(backupKeyPath, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' }); created.push(backupKeyPath)
    await chmod(configPath, 0o640)
    await chmod(secretsPath, 0o600)
    await chmod(backupKeyPath, 0o600)
    await Promise.all([syncFile(configPath), syncFile(secretsPath), syncFile(backupKeyPath)])
  } catch (error) {
    for (const path of created.reverse()) await rm(path, { force: true })
    throw error
  }
  return { configPath, secretsPath, backupKeyPath, stateRoot, appUrl }
}

export async function updateProductionProjectRuntime(configPath, runtimeValue) {
  const absolute = resolve(configPath)
  const runtime = resolveProjectRuntime(runtimeValue)
  const before = await lstat(absolute)
  if (!before.isFile() || (before.mode & 0o022) !== 0) throw new Error(`Production configuration is not a protected regular file: ${absolute}`)
  const source = await readFile(absolute, 'utf8')
  const values = parseEnvironmentFile(source)
  const previous = resolveProjectRuntime(values.OPENLINK_PROJECT_RUNTIME)
  if (previous !== runtime) {
    const stateRoot = values.OPENLINK_STATE_ROOT
    if (!stateRoot) throw new Error('Production configuration has no OPENLINK_STATE_ROOT')
    const previousProjectsRoot = join(resolve(stateRoot), previous === 'vm' ? 'project-vms/projects' : 'project-containers/projects')
    const persisted = await readdir(previousProjectsRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))
    if (persisted.some((entry) => entry.isDirectory())) {
      throw new Error(`Cannot change Project backend from ${previous} to ${runtime} while persisted Projects exist; migrate or remove those runtimes first`)
    }
  }
  const replacements = {
    OPENLINK_PROJECT_RUNTIME: runtime,
    OPENLINK_PROJECT_ISOLATION: runtime === 'vm' ? 'vm' : 'container',
  }
  let output = source
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm')
    output = pattern.test(output) ? output.replace(pattern, `${key}=${value}`) : `${output.replace(/\s*$/, '\n')}${key}=${value}\n`
  }
  if (output !== source) {
    await durableWriteFile(absolute, output, { mode: before.mode & 0o777 })
    await chmod(absolute, before.mode & 0o777)
    await syncFile(absolute)
  }
  return { configPath: absolute, previousRuntime: previous, runtime, changed: previous !== runtime }
}
