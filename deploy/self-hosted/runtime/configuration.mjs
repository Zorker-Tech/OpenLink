import { createHmac, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parseEnvironmentFile } from './preflight.mjs'

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
  const stateRoot = resolve(options.stateRoot)
  const appUrl = safeHttpsUrl(options.appUrl, options.allowInsecure === true)
  const gatewayUrl = safeHttpsUrl(options.gatewayUrl ?? appUrl, options.allowInsecure === true)
  const parsedAppUrl = new URL(appUrl)
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
    OPENLINK_RUNTIME_MODE: 'local',
    OPENLINK_APP_URL: appUrl,
    OPENLINK_EDGE_ADDRESS: `${parsedAppUrl.protocol === 'http:' ? 'http://' : ''}${parsedAppUrl.host}`,
    OPENLINK_BROWSER_GATEWAY_PUBLIC_URL: gatewayUrl,
    OPENLINK_BROWSER_GATEWAY_ALLOWED_ORIGINS: appUrl,
    OPENLINK_STATE_ROOT: stateRoot,
    OPENLINK_LOG_ROOT: resolve(options.logRoot ?? join(stateRoot, 'logs')),
    OPENLINK_BACKUP_ROOT: resolve(options.backupRoot ?? join(dirname(stateRoot), 'backups')),
    OPENLINK_BACKUP_KEY_FILE: backupKeyPath,
    OPENLINK_SECRETS_FILE: secretsPath,
    OPENLINK_ZOKERBASE_ENV_FILE: secretsPath,
    OPENLINK_AGENT_MAX_SESSIONS: String(options.maxSessions ?? 32),
    OPENLINK_PROJECT_VM_CPUS: String(options.vmCpus ?? 4),
    OPENLINK_PROJECT_VM_MEMORY_MB: String(options.vmMemoryMb ?? 8192),
    OPENLINK_PROJECT_VM_DISK_GB: String(options.vmDiskGb ?? 64),
    ...(options.allowInsecure ? { OPENLINK_ALLOW_INSECURE_HTTP: '1' } : {}),
  }
  const secrets = {
    ...zokerbase,
    OPENLINK_BROWSER_API_TOKEN: token(),
    OPENLINK_BROWSER_TOKEN_SECRET: token(),
    OPENLINK_AGENT_API_TOKEN: token(),
    OPENLINK_DESKTOP_AGENT_API_TOKEN: token(),
    OPENLINK_PROVIDER_SECRET_KEY: token(),
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
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
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
    await writeFile(configPath, serialize(config, ['Generated by openlinkctl configure.', 'Contains no secret values.']), { mode: 0o640, flag: 'wx' }); created.push(configPath)
    await writeFile(secretsPath, serialize(secrets, ['Generated secret material. Do not copy into logs or source control.']), { mode: 0o600, flag: 'wx' }); created.push(secretsPath)
    await writeFile(backupKeyPath, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' }); created.push(backupKeyPath)
    await chmod(configPath, 0o640)
    await chmod(secretsPath, 0o600)
    await chmod(backupKeyPath, 0o600)
  } catch (error) {
    for (const path of created.reverse()) await rm(path, { force: true })
    throw error
  }
  return { configPath, secretsPath, backupKeyPath, stateRoot, appUrl }
}
