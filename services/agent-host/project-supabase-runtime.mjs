#!/usr/bin/env node
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { appendFile, chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import {
  readTrustedReleaseKeys,
  validateBundleManifest,
  verifyBundleFiles,
  verifyBundleManifestSignature,
} from './project-supabase-bundle.mjs'

const IMMUTABLE_ROOT = '/usr/lib/openlink/project-supabase'
const STATE_ROOT = '/var/lib/openlink/project-supabase'
const RELEASE_TRUST = '/usr/lib/openlink/project-supabase/release-trust.json'
const CONTAINER_ENGINE = process.env.OPENLINK_PROJECT_CONTAINER_ENGINE?.trim() || 'podman'
if (!['podman', 'docker'].includes(CONTAINER_ENGINE)) throw new Error('Project Supabase runtime: unsupported container engine')
const PROJECT_NAMESPACE = process.env.OPENLINK_PROJECT_CONTAINER_NAMESPACE?.trim() || ''
if (PROJECT_NAMESPACE && !/^[a-f0-9]{8,32}$/.test(PROJECT_NAMESPACE)) throw new Error('Project Supabase runtime: invalid container namespace')
const CONTAINER_PREFIX = PROJECT_NAMESPACE ? `openlink-project-${PROJECT_NAMESPACE}-supabase-` : 'openlink-project-supabase-'
const NETWORK = PROJECT_NAMESPACE ? `openlink-project-${PROJECT_NAMESPACE}-supabase` : 'openlink-project-supabase'
const SUPPORTED_SERVICE_FIELDS = new Set(['image', 'depends_on', 'entrypoint', 'environment', 'healthcheck', 'networks', 'ports', 'restart', 'volumes', 'command'])
const RELEASE_NAME = /^self-hosted\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

function fail(message) {
  throw new Error(`Project Supabase runtime: ${message}`)
}

function normalizeImageId(value) {
  if (/^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value
  fail('image id format is invalid')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function b64url(value) {
  return Buffer.from(value).toString('base64url')
}

function signHs256(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`
}

function signEs256(payload, privateKey, kid) {
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }))
  const body = b64url(JSON.stringify(payload))
  const data = `${header}.${body}`
  const signature = sign('SHA256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${data}.${signature}`
}

function opaqueKey(prefix) {
  const intermediate = `${prefix}${randomBytes(17).toString('base64url').slice(0, 22)}`
  // Keep the exact upstream self-hosted API-key format. Isolation comes from
  // independent random keys per Project VM, not from changing Supabase's
  // checksum namespace and risking future SDK validation incompatibility.
  const checksum = createHash('sha256').update(`supabase-self-hosted|${intermediate}`).digest('base64url').slice(0, 8)
  return `${intermediate}_${checksum}`
}

export function generateProjectSupabaseSecrets(projectId, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!/^[a-f0-9-]{36}$/i.test(projectId)) fail('project id is invalid')
  const jwtSecret = randomBytes(32).toString('base64url')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const privateJwk = privateKey.export({ format: 'jwk' })
  const kid = randomUUID()
  const oct = { kty: 'oct', k: b64url(jwtSecret), alg: 'HS256' }
  const privateEc = { kty: 'EC', kid, use: 'sig', key_ops: ['sign', 'verify'], alg: 'ES256', ext: true, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d }
  const publicEc = { kty: 'EC', kid, use: 'sig', key_ops: ['verify'], alg: 'ES256', ext: true, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y }
  const exp = nowSeconds + 5 * 365 * 24 * 60 * 60
  const claims = (role) => ({ role, iss: 'supabase', iat: nowSeconds, exp })
  return {
    schemaVersion: 1,
    projectId,
    POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    JWT_SECRET: jwtSecret,
    ANON_KEY: signHs256(claims('anon'), jwtSecret),
    SERVICE_ROLE_KEY: signHs256(claims('service_role'), jwtSecret),
    SUPABASE_PUBLISHABLE_KEY: opaqueKey('sb_publishable_'),
    SUPABASE_SECRET_KEY: opaqueKey('sb_secret_'),
    ANON_KEY_ASYMMETRIC: signEs256(claims('anon'), privateKey, kid),
    SERVICE_ROLE_KEY_ASYMMETRIC: signEs256(claims('service_role'), privateKey, kid),
    JWT_KEYS: JSON.stringify([privateEc, oct]),
    JWT_JWKS: JSON.stringify({ keys: [publicEc, oct] }),
    DASHBOARD_USERNAME: 'supabase',
    DASHBOARD_PASSWORD: randomBytes(24).toString('base64url'),
    SECRET_KEY_BASE: randomBytes(48).toString('base64'),
    REALTIME_DB_ENC_KEY: randomBytes(8).toString('hex'),
    VAULT_ENC_KEY: randomBytes(16).toString('hex'),
    PG_META_CRYPTO_KEY: randomBytes(32).toString('base64url'),
    S3_PROTOCOL_ACCESS_KEY_ID: randomBytes(16).toString('hex'),
    S3_PROTOCOL_ACCESS_KEY_SECRET: randomBytes(32).toString('hex'),
    generatedAt: new Date(nowSeconds * 1000).toISOString(),
  }
}

export function parseEnvTemplate(source) {
  const values = {}
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) fail(`invalid environment template line: ${line}`)
    const key = line.slice(0, separator)
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`invalid environment variable ${key}`)
    let value = line.slice(separator + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values[key] = value
  }
  return values
}

function findClosingBrace(value, start) {
  let depth = 1
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '$' && value[index + 1] === '{') {
      depth += 1
      index += 1
    } else if (value[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

export function interpolate(value, environment, depth = 0) {
  if (typeof value !== 'string') return String(value)
  if (depth > 20) fail('environment interpolation exceeded maximum depth')
  let output = ''
  for (let index = 0; index < value.length;) {
    if (value[index] !== '$' || value[index + 1] !== '{') {
      output += value[index]
      index += 1
      continue
    }
    const end = findClosingBrace(value, index + 2)
    if (end < 0) fail(`unterminated environment expression in ${value}`)
    const expression = value.slice(index + 2, end)
    const fallbackIndex = expression.indexOf(':-')
    const key = fallbackIndex < 0 ? expression : expression.slice(0, fallbackIndex)
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`unsupported environment expression \${${expression}}`)
    const fallback = fallbackIndex < 0 ? undefined : expression.slice(fallbackIndex + 2)
    const candidate = environment[key]
    // ${VAR} (no fallback): only undefined is an error — an explicitly empty
    // string is a valid value.  ${VAR:-default} (with fallback): use the
    // fallback when the variable is unset OR empty, matching bash semantics.
    if (candidate === undefined && fallback === undefined) fail(`required environment variable ${key} is missing`)
    const useFallback = (candidate === undefined || candidate === '') && fallback !== undefined
    output += interpolate(useFallback ? fallback : (candidate !== undefined ? String(candidate) : ''), environment, depth + 1)
    index = end + 1
  }
  return output
}

export function validateRuntimeSpec(input, lock) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1 || !input.compose?.services) fail('runtime spec is invalid')
  const services = input.compose.services
  for (const [name, service] of Object.entries(services)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || !service || typeof service !== 'object' || Array.isArray(service)) fail(`service ${name} is invalid`)
    for (const field of Object.keys(service)) if (!SUPPORTED_SERVICE_FIELDS.has(field)) fail(`service ${name} uses unsupported field ${field}`)
    if (typeof service.image !== 'string' || !service.image.includes(':')) fail(`service ${name} image is invalid`)
    if (service.environment && (typeof service.environment !== 'object' || Array.isArray(service.environment))) fail(`service ${name} environment is invalid`)
    if (service.volumes && !Array.isArray(service.volumes)) fail(`service ${name} volumes are invalid`)
    if (service.ports && !Array.isArray(service.ports)) fail(`service ${name} ports are invalid`)
    if (service.ports?.length && !['api-gw', 'supavisor'].includes(name)) fail(`service ${name} may not publish ports`)
    if (name === 'api-gw' && service.ports?.length !== 1) fail('api-gw must publish exactly one port')
    if (name === 'supavisor' && service.ports?.length !== 2) fail('supavisor must publish exactly two ports')
  }
  if (lock) {
    const actual = Object.keys(services).sort()
    const expected = lock.services.map((service) => service.name).sort()
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) fail('runtime spec service set does not match lock')
    for (const expectedService of lock.services) if (services[expectedService.name].image !== expectedService.image) fail(`runtime spec image ${expectedService.name} does not match lock`)
  }
  return input
}

export function dependencyOrder(services) {
  const ordered = []
  const visiting = new Set()
  const visited = new Set()
  const visit = (name) => {
    if (visited.has(name)) return
    if (visiting.has(name)) fail(`dependency cycle includes ${name}`)
    if (!services[name]) fail(`dependency ${name} does not exist`)
    visiting.add(name)
    for (const dependency of Object.keys(services[name].depends_on ?? {}).sort()) visit(dependency)
    visiting.delete(name)
    visited.add(name)
    ordered.push(name)
  }
  for (const name of Object.keys(services).sort()) visit(name)
  return ordered
}

function podman(args, options = {}) {
  try {
    return execFileSync(CONTAINER_ENGINE, args, { encoding: 'utf8', stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 'unknown'
    // `podman create` argv contains project secrets. Never surface the child
    // argv or stdout. Preserve only the
    // runtime's stderr (never argv/stdout), redact all caller-provided secret
    // values, and cap it so provisioning failures are actionable without
    // turning the controller into a secret or log exfiltration path.
    const raw = typeof error?.stderr === 'string'
      ? error.stderr
      : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : ''
    let detail = raw
    for (const secret of options.redactValues ?? []) {
      if (typeof secret === 'string' && secret.length >= 8) detail = detail.replaceAll(secret, '[REDACTED]')
    }
    detail = detail.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000)
    fail(`Podman ${args[0] || 'operation'} failed with status ${status}${detail ? `: ${detail}` : ''}`)
  }
}

function containerName(service) {
  return `${CONTAINER_PREFIX}${service}`
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`
}

function healthCommand(test) {
  if (!Array.isArray(test) || test.length < 2) fail('healthcheck.test is invalid')
  if (test[0] === 'CMD-SHELL') return test.slice(1).join(' ')
  // Podman's --health-cmd accepts a JSON argv array. A plain string is always
  // executed via /bin/sh -c, which breaks valid Compose CMD probes in minimal
  // images (for example postgrest has no shell). Preserve the Compose contract
  // exactly: CMD is an exec-form argv, CMD-SHELL is a shell-form string.
  if (test[0] === 'CMD') return JSON.stringify(test.slice(1))
  fail(`unsupported healthcheck form ${test[0]}`)
}

function duration(value) {
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?(?:ns|us|ms|s|m|h)$/.test(value)) fail(`invalid duration ${value}`)
  return value
}

function projectEnvironment(template, secrets, options) {
  const gateway = options.gatewayPort
  return {
    ...template,
    ...secrets,
    POSTGRES_HOST: 'db',
    POSTGRES_DB: 'postgres',
    POSTGRES_PORT: '5432',
    POOLER_PROXY_PORT_TRANSACTION: '6543',
    POOLER_DEFAULT_POOL_SIZE: template.POOLER_DEFAULT_POOL_SIZE || '20',
    POOLER_MAX_CLIENT_CONN: template.POOLER_MAX_CLIENT_CONN || '100',
    POOLER_DB_POOL_SIZE: template.POOLER_DB_POOL_SIZE || '5',
    POOLER_TENANT_ID: options.projectId.replaceAll('-', ''),
    SUPABASE_PUBLIC_URL: `http://127.0.0.1:${gateway}`,
    API_EXTERNAL_URL: `http://127.0.0.1:${gateway}/auth/v1`,
    SITE_URL: options.siteUrl,
    ADDITIONAL_REDIRECT_URLS: options.additionalRedirectUrls,
    API_GW_HTTP_PORT: String(gateway),
    KONG_HTTP_PORT: String(gateway),
    KONG_HTTPS_PORT: '8443',
    STUDIO_DEFAULT_ORGANIZATION: 'Project VM',
    STUDIO_DEFAULT_PROJECT: options.projectId,
    // Podman Machine may inject HTTP_PROXY into the container environment.
    // Health checks and inter-service communication must bypass the proxy for
    // loopback and internal service hostnames, otherwise wget/curl in
    // healthchecks routes through the host proxy and fails with 503.
    NO_PROXY: 'localhost,127.0.0.1,::1,api-gw,auth,db,rest,realtime,storage,functions,imgproxy,meta,supavisor,studio,supabase-mail',
    no_proxy: 'localhost,127.0.0.1,::1,api-gw,auth,db,rest,realtime,storage,functions,imgproxy,meta,supavisor,studio,supabase-mail',
    OPENAI_API_KEY: 'sk-not-configured',
    // The embedded backend has no mail relay until a project configures one.
    // Auto-confirm keeps email Auth functional and deterministic out of the
    // box.  The interpolate() helper rejects empty strings as "missing", so
    // use explicit sentinel values that Supabase services will never attempt
    // to contact (ENABLE_EMAIL_AUTOCONFIRM suppresses all SMTP delivery).
    SMTP_HOST: template.SMTP_HOST === 'supabase-mail' ? 'smtp-disabled' : template.SMTP_HOST,
    SMTP_USER: template.SMTP_USER === 'fake_mail_user' ? 'disabled' : template.SMTP_USER,
    SMTP_PASS: template.SMTP_PASS === 'fake_mail_password' ? 'disabled' : template.SMTP_PASS,
    ENABLE_EMAIL_AUTOCONFIRM: 'true',
    // The embedded backend has no mail relay until a project configures one.
    // Auto-confirm keeps email Auth functional and deterministic out of the
    // box instead of issuing confirmation links to the upstream fake host.
    ENABLE_EMAIL_AUTOCONFIRM: 'true',
  }
}

function resolveBindSource(source, options) {
  if (!source.startsWith('configuration/')) fail(`bind source ${source} is outside locked configuration`)
  const relative = source.slice('configuration/'.length)
  const mutable = new Map([
    ['volumes/db/data', resolve(options.stateRoot, 'data/postgres')],
    ['volumes/storage', resolve(options.stateRoot, 'data/storage')],
    ['volumes/functions', resolve(options.workspace, 'supabase/functions')],
    ['volumes/snippets', resolve(options.stateRoot, 'data/snippets')],
  ])
  const mapped = mutable.get(relative)
  if (mapped) return mapped
  const path = resolve(options.stateRoot, 'configuration', relative)
  const root = `${resolve(options.stateRoot, 'configuration')}${sep}`
  if (!path.startsWith(root)) fail(`bind source ${source} escapes configuration root`)
  return path
}

export function serviceCreateArgs(name, service, environment, options) {
  const args = ['create', '--name', containerName(name), '--network', NETWORK, '--label', 'io.openlink.project-supabase=true', '--label', `io.openlink.project-supabase.service=${name}`, '--label', `io.openlink.project-supabase.revision=${options.release}`, '--label', `io.openlink.project-supabase.config=${options.configHash}`, '--security-opt', 'label=disable']
  // Podman Machine injects HTTP_PROXY into all containers at the machine
  // level.  The Supabase backend is fully internal to the VM, so clear proxy
  // variables to prevent health checks and inter-service traffic from routing
  // through the host proxy (which returns 503 for internal endpoints).
  for (const proxyVar of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) args.push('--env', `${proxyVar}=`)
  // Some upstream docker-compose services omit ANON_KEY even though their
  // health checks reference ${ANON_KEY}.  Always provide it so shell-based
  // health checks can expand the variable.
  if (environment.ANON_KEY && !(service.environment ?? {})[ 'ANON_KEY' ]) args.push('--env', `ANON_KEY=${environment.ANON_KEY}`)
  for (const alias of service.networks?.default?.aliases ?? []) args.push('--network-alias', alias)
  args.push('--network-alias', name)
  // The Envoy API gateway references the Realtime service by the DNS name
  // "realtime-dev.supabase-realtime" (from the upstream cluster config).
  // The synced runtime spec may not include this as a network alias, so
  // add it explicitly to ensure the gateway can route WebSocket connections.
  if (name === 'realtime') args.push('--network-alias', 'realtime-dev.supabase-realtime')
  if (service.restart) args.push('--restart', service.restart)
  if (service.entrypoint) args.push('--entrypoint', JSON.stringify(service.entrypoint))
  for (const [key, raw] of Object.entries(service.environment ?? {}).sort(([left], [right]) => left.localeCompare(right))) args.push('--env', `${key}=${interpolate(String(raw), environment)}`)
  for (const volume of service.volumes ?? []) {
    if (!volume || typeof volume !== 'object' || typeof volume.target !== 'string') fail(`service ${name} volume is invalid`)
    let source
    const suffix = []
    if (volume.type === 'bind') {
      source = resolveBindSource(volume.source, options)
      const selinux = volume.bind?.selinux
      if (selinux) suffix.push(selinux)
    } else if (volume.type === 'volume') {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(volume.source)) fail(`service ${name} named volume is invalid`)
      source = `${NETWORK}-${volume.source}`
    } else fail(`service ${name} volume type ${volume.type} is unsupported`)
    if (volume.read_only) suffix.push('ro')
    args.push('--volume', `${source}:${volume.target}${suffix.length ? `:${suffix.join(',')}` : ''}`)
  }
  if (name === 'api-gw') args.push('--publish', `127.0.0.1:${options.gatewayPort}:8000/tcp`)
  if (name === 'supavisor') {
    args.push('--publish', `127.0.0.1:${options.databasePort}:5432/tcp`)
    args.push('--publish', `127.0.0.1:${options.poolerPort}:6543/tcp`)
  }
  const health = service.healthcheck
  if (health) {
    args.push('--health-cmd', healthCommand(health.test))
    if (health.interval) args.push('--health-interval', duration(health.interval))
    if (health.timeout) args.push('--health-timeout', duration(health.timeout))
    if (health.start_period) args.push('--health-start-period', duration(health.start_period))
    if (health.retries !== undefined) {
      if (!Number.isSafeInteger(health.retries) || health.retries < 1) fail(`service ${name} health retries is invalid`)
      args.push('--health-retries', String(health.retries))
    }
  }
  args.push(service.image)
  if (Array.isArray(service.command)) args.push(...service.command.map(String))
  else if (typeof service.command === 'string') args.push('/bin/sh', '-c', service.command)
  return args
}

async function atomicJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await rename(temporary, path)
  await chmod(path, mode)
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function acquireLifecycleLock(stateRoot, command) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const lockRoot = resolve(stateRoot, '.lifecycle.lock')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await mkdir(lockRoot, { mode: 0o700 })
      await atomicJson(resolve(lockRoot, 'owner.json'), { schemaVersion: 1, pid: process.pid, command, acquiredAt: new Date().toISOString() })
      return async () => {
        const owner = JSON.parse(await readFile(resolve(lockRoot, 'owner.json'), 'utf8')).pid
        if (owner !== process.pid) fail('lifecycle lock ownership changed unexpectedly')
        await rm(lockRoot, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(resolve(lockRoot, 'owner.json'), 'utf8')) } catch { }
      if (owner && processIsAlive(owner.pid)) fail(`lifecycle operation ${owner.command || 'unknown'} is already running`)
      // The owner file is written immediately after mkdir. Briefly retry an
      // empty directory before classifying it as a crashed owner.
      if (!owner && attempt < 5) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
        continue
      }
      const staleRoot = `${lockRoot}.stale-${process.pid}-${randomBytes(6).toString('hex')}`
      try { await rename(lockRoot, staleRoot) } catch (renameError) {
        if (renameError?.code === 'ENOENT') continue
        throw renameError
      }
      await rm(staleRoot, { recursive: true, force: true })
    }
  }
  fail('could not acquire lifecycle lock')
}

function releaseDirectory(stateRoot, release) {
  const match = RELEASE_NAME.exec(release)
  if (!match) fail(`release ${release} is invalid`)
  return resolve(stateRoot, 'releases', `v${match[1]}.${match[2]}.${match[3]}`)
}

async function activeRuntimeRoot(options) {
  const path = resolve(options.stateRoot, 'active-release.json')
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    const expected = releaseDirectory(options.stateRoot, value.release)
    if (value.root !== expected) fail('active release root is invalid')
    return expected
  } catch (error) {
    if (error?.code === 'ENOENT') return options.immutableRoot
    throw error
  }
}

export function compareRelease(left, right) {
  const a = RELEASE_NAME.exec(left)
  const b = RELEASE_NAME.exec(right)
  if (!a || !b) fail('release version is invalid')
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference) return difference
  }
  return 0
}

export function upgradeGates(current, targetLock) {
  if (compareRelease(targetLock.release.tag, current) <= 0) fail(`target release ${targetLock.release.tag} must be newer than ${current}`)
  return targetLock.upgradeGates.filter((gate) => compareRelease(`self-hosted/v${gate.version}`, current) > 0 && compareRelease(`self-hosted/v${gate.version}`, targetLock.release.tag) <= 0)
}

async function loadOrCreateSecrets(options) {
  const path = resolve(options.stateRoot, 'secrets.json')
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.schemaVersion !== 1 || value.projectId !== options.projectId || !value.JWT_SECRET || !value.POSTGRES_PASSWORD || !value.JWT_KEYS) fail('persisted secrets are invalid')
    return value
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const value = generateProjectSupabaseSecrets(options.projectId)
    await atomicJson(path, value)
    return value
  }
}

async function verifySeed(lock, options) {
  const golden = options.immutableRoot === IMMUTABLE_ROOT
  const artifactPath = golden ? resolve(options.stateRoot, 'seed.json') : resolve(options.immutableRoot, 'image-manifest.json')
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
  const seed = golden ? artifact : {
    release: artifact.release?.tag,
    commit: artifact.release?.commit,
    architecture: artifact.architecture,
    configurationTreeSha256: artifact.configurationTreeSha256,
    imageArtifacts: artifact.images,
  }
  if (seed.release !== lock.release.tag || seed.commit !== lock.release.commit || seed.architecture !== guestArchitecture() || seed.configurationTreeSha256 !== lock.configuration.treeSha256 || !Array.isArray(seed.imageArtifacts)) fail('Project Supabase image attestation does not match runtime lock')
  if (seed.imageArtifacts.length !== lock.services.length) fail('Golden Image Supabase seed is incomplete')
  for (const expected of lock.services) {
    const artifact = seed.imageArtifacts.find((candidate) => candidate.service === expected.name)
    if (!artifact || artifact.image !== expected.image || artifact.platformDigest !== expected.platforms[guestArchitecture()].digest) fail(`Project Supabase image attestation is missing image ${expected.name}`)
    let observed
    try { observed = normalizeImageId(podman(['image', 'inspect', '--format', '{{.Id}}', expected.image], { capture: true })) } catch {}
    if (!golden && observed !== artifact.imageId) {
      if (!/^[A-Za-z0-9._-]+$/.test(artifact.archive || '') || !/^[a-f0-9]{64}$/.test(artifact.archiveSha256 || '')) fail(`Project Supabase image archive metadata is invalid for ${expected.name}`)
      const archive = resolve(options.immutableRoot, 'images', artifact.archive)
      if (await sha256File(archive) !== artifact.archiveSha256) fail(`Project Supabase image archive checksum failed for ${expected.name}`)
      podman(['load', '--input', archive])
      observed = normalizeImageId(podman(['image', 'inspect', '--format', '{{.Id}}', expected.image], { capture: true }))
    }
    if (observed !== artifact.imageId) fail(`Project Supabase image id mismatch for ${expected.name}`)
  }
}

function guestArchitecture() {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  fail(`unsupported Project VM architecture ${process.arch}`)
}

async function verifyUpgradeBundle(bundleRoot, targetLock, options) {
  const manifest = JSON.parse(await readFile(resolve(bundleRoot, 'bundle.manifest.json'), 'utf8'))
  validateBundleManifest(manifest, targetLock, guestArchitecture())
  const lockSha256 = sha256(await readFile(resolve(bundleRoot, 'runtime.lock.json')))
  if (manifest.lockSha256 !== lockSha256) fail('upgrade bundle runtime lock checksum does not match manifest')
  const keys = await readTrustedReleaseKeys(options.releaseTrust || RELEASE_TRUST)
  const trusted = keys.get(manifest.keyId)
  if (!trusted || trusted.status !== 'active') fail(`upgrade bundle release key ${manifest.keyId} is not active`)
  const signature = (await readFile(resolve(bundleRoot, 'bundle.signature'), 'utf8')).trim()
  verifyBundleManifestSignature(manifest, signature, trusted.publicKeyPem)
  await verifyBundleFiles(bundleRoot, manifest)
  const imageManifest = JSON.parse(await readFile(resolve(bundleRoot, 'image-manifest.json'), 'utf8'))
  if (imageManifest.architecture !== guestArchitecture() || imageManifest.release?.tag !== targetLock.release.tag || imageManifest.release?.commit !== targetLock.release.commit || imageManifest.configurationTreeSha256 !== targetLock.configuration.treeSha256) fail('upgrade bundle image manifest does not match target lock')
  if (!Array.isArray(imageManifest.images) || imageManifest.images.length !== targetLock.services.length) fail('upgrade bundle image manifest is incomplete')
  for (const service of targetLock.services) {
    const artifact = imageManifest.images.find((candidate) => candidate.service === service.name)
    if (!artifact || artifact.image !== service.image || artifact.platformDigest !== service.platforms[guestArchitecture()].digest || !/^sha256:[a-f0-9]{64}$/.test(artifact.imageId) || !/^[A-Za-z0-9._-]+$/.test(artifact.archive) || !/^[a-f0-9]{64}$/.test(artifact.archiveSha256)) fail(`upgrade bundle image artifact ${service.name} is invalid`)
    const expectedFile = manifest.files.find((candidate) => candidate.path === `images/${artifact.archive}`)
    if (!expectedFile || expectedFile.sha256 !== artifact.archiveSha256 || expectedFile.bytes !== artifact.archiveBytes) fail(`upgrade bundle archive attestation ${service.name} is invalid`)
  }
  return { manifest, imageManifest }
}

async function importUpgradeImages(bundleRoot, targetLock, imageManifest) {
  const imported = []
  for (const service of targetLock.services) {
    const artifact = imageManifest.images.find((candidate) => candidate.service === service.name)
    let observed
    try { observed = normalizeImageId(podman(['image', 'inspect', '--format', '{{.Id}}', service.image], { capture: true })) } catch { }
    if (observed !== artifact.imageId) {
      podman(['load', '--input', resolve(bundleRoot, 'images', artifact.archive)])
      imported.push(service.name)
      observed = normalizeImageId(podman(['image', 'inspect', '--format', '{{.Id}}', service.image], { capture: true }))
    }
    if (observed !== artifact.imageId) fail(`upgrade bundle image ${service.name} failed local identity verification`)
  }
  return imported
}

async function treeBytes(path) {
  let metadata
  try { metadata = await lstat(path) } catch (error) { if (error?.code === 'ENOENT') return 0; throw error }
  if (metadata.isSymbolicLink()) fail(`upgrade snapshot source ${path} cannot be a symbolic link`)
  if (metadata.isFile()) return metadata.blocks ? metadata.blocks * 512 : metadata.size
  if (!metadata.isDirectory()) fail(`upgrade snapshot source ${path} has unsupported type`)
  let total = 0
  for (const entry of await readdir(path)) total += await treeBytes(resolve(path, entry))
  return total
}

async function preflightUpgradeCapacity(options, imageManifest) {
  let imageBytes = 0
  for (const artifact of imageManifest.images) {
    let observed
    try { observed = normalizeImageId(podman(['image', 'inspect', '--format', '{{.Id}}', artifact.image], { capture: true })) } catch { }
    if (observed !== artifact.imageId) imageBytes += artifact.archiveBytes
  }
  const snapshotBytes = await treeBytes(resolve(options.stateRoot, 'data'))
    + await treeBytes(resolve(options.stateRoot, 'configuration'))
    + await treeBytes(resolve(options.workspace, 'supabase/functions'))
    + await treeBytes(resolve(options.stateRoot, 'secrets.json'))
  const filesystem = await statfs(options.stateRoot, { bigint: true })
  const available = filesystem.bavail * filesystem.bsize
  // Archive size is a conservative proxy for local layer expansion. Keep 2
  // GiB untouched so rollback metadata and the host OS cannot be starved.
  const required = BigInt(imageBytes + snapshotBytes) + 2n * 1024n * 1024n * 1024n
  if (available < required) fail(`upgrade requires ${required} free bytes but only ${available} are available`)
  return { availableBytes: available.toString(), requiredBytes: required.toString(), imageBytes, snapshotBytes }
}

async function copyConfiguration(options, lock) {
  const destination = resolve(options.stateRoot, 'configuration')
  const marker = resolve(destination, '.openlink-tree-sha256')
  const current = await readFile(marker, 'utf8').catch(() => '')
  if (current.trim() === lock.configuration.treeSha256) return
  const temporary = `${destination}.${process.pid}.tmp`
  await rm(temporary, { recursive: true, force: true })
  await cp(resolve(options.immutableRoot, 'configuration'), temporary, { recursive: true, preserveTimestamps: true })
  await writeFile(resolve(temporary, '.openlink-tree-sha256'), `${lock.configuration.treeSha256}\n`, { mode: 0o600 })
  await rm(destination, { recursive: true, force: true })
  await rename(temporary, destination)
}

async function ensurePaths(spec, options) {
  const paths = new Set([resolve(options.stateRoot, 'data/postgres'), resolve(options.stateRoot, 'data/storage'), resolve(options.stateRoot, 'data/snippets'), resolve(options.workspace, 'supabase/functions')])
  for (const service of Object.values(spec.compose.services)) {
    for (const volume of service.volumes ?? []) if (volume.type === 'bind') paths.add(resolveBindSource(volume.source, options))
  }
  for (const path of paths) {
    const extension = basename(path).includes('.')
    if (extension) await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    else await mkdir(path, { recursive: true, mode: 0o700 })
  }
}

async function ensureProjectFunctions(options) {
  const source = resolve(options.immutableRoot, 'configuration/volumes/functions')
  const destination = resolve(options.workspace, 'supabase/functions')
  const main = resolve(destination, 'main/index.ts')
  try {
    const metadata = await stat(main)
    if (!metadata.isFile() || metadata.size === 0) fail('project Edge Functions main entrypoint is invalid')
    return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${process.pid}.tmp`
  await rm(temporary, { recursive: true, force: true })
  await cp(source, temporary, { recursive: true, preserveTimestamps: true })
  await rename(temporary, destination)
}

const MANAGEMENT_OPERATIONS = new Set(['tables', 'database', 'query', 'auth-users', 'storage-buckets', 'functions', 'realtime', 'services', 'logs'])
const LOG_SERVICES = new Set(['api-gw', 'auth', 'db', 'rest', 'realtime', 'storage', 'functions', 'meta', 'supavisor'])
const STUDIO_PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const STUDIO_PROXY_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'if-none-match', 'if-modified-since', 'range', 'user-agent', 'x-client-info', 'x-supabase-client', 'x-supabase-client-platform', 'x-supabase-client-version'])
const STUDIO_PROXY_RESPONSE_HEADERS = new Set(['cache-control', 'content-language', 'content-range', 'content-type', 'etag', 'last-modified', 'location'])

function managementQuery(value) {
  if (typeof value !== 'string') fail('management query is required')
  const query = value.trim().replace(/;+\s*$/, '')
  if (!query || query.length > 12_000) fail('management query is invalid')
  if (query.includes(';') || !/^(select|with|explain|show)\b/i.test(query)) fail('only one read-only SQL statement is allowed')
  if (/\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|vacuum|refresh|set|reset)\b/i.test(query)) fail('management query contains a write or session-control keyword')
  return query
}

const ACCESS_MODES = ['restricted', 'ask', 'open']

function normalizeAccessMode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'restricted'
  return ACCESS_MODES.includes(normalized) ? normalized : 'restricted'
}

function writeQuery(value) {
  if (typeof value !== 'string') fail('management query is required')
  const query = value.trim()
  if (!query || query.length > 12_000) fail('management query is invalid')
  return query
}

async function appendFirewallAudit(options, record) {
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      projectId: options.projectId,
      mode: record.mode,
      operation: record.operation,
      sql: (record.query || '').slice(0, 500),
      decision: record.decision,
    })
    await appendFile(resolve(options.stateRoot, 'firewall-audit.jsonl'), line + '\n', 'utf8')
  } catch {
    // Auditing is best-effort; never block management on a write failure.
  }
}

function databaseQuery(sql) {
  return podman([
    'exec', containerName('db'), 'psql',
    '--username', 'postgres', '--dbname', 'postgres',
    '--tuples-only', '--no-align', '--no-psqlrc', '--command', sql,
  ], { capture: true })
}

async function adminRequest(options, secrets, path) {
  const response = await fetch(`http://127.0.0.1:${options.gatewayPort}${path}`, {
    headers: { apikey: secrets.SERVICE_ROLE_KEY, Authorization: `Bearer ${secrets.SERVICE_ROLE_KEY}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) fail(`Supabase management API returned ${response.status}`)
  return response.json()
}

async function manageRuntime(options) {
  if (!MANAGEMENT_OPERATIONS.has(options.operation)) fail('management operation is invalid')
  const secrets = await loadOrCreateSecrets(options)
  if (options.operation === 'tables') {
    const value = databaseQuery(`select coalesce(json_agg(json_build_object('schema', table_schema, 'name', table_name, 'kind', table_type) order by table_schema, table_name), '[]'::json) from information_schema.tables where table_schema in ('public', 'auth', 'storage') and table_type = 'BASE TABLE'`)
    return { operation: 'tables', tables: JSON.parse(value || '[]') }
  }
  if (options.operation === 'database') {
    const value = databaseQuery(`select json_build_object('version', current_setting('server_version'), 'size', pg_size_pretty(pg_database_size(current_database())), 'connections', (select count(*) from pg_stat_activity where datname = current_database()))`)
    return { operation: 'database', database: JSON.parse(value || '{}') }
  }
  if (options.operation === 'query') {
    const mode = normalizeAccessMode(options.mode)
    if (mode === 'restricted') {
      const query = managementQuery(options.query)
      await appendFirewallAudit(options, { mode, operation: 'query', query, decision: 'allow' })
      return { operation: 'query', query, csv: databaseQuery(query) }
    }
    // 'ask' restricts to a single statement (confirmation happens at the MCP
    // layer); 'open' is full access with no statement/write restrictions.
    const query = mode === 'open'
      ? (typeof options.query === 'string' ? options.query.trim() : '')
      : writeQuery(options.query)
    if (!query) fail('management query is required')
    await appendFirewallAudit(options, { mode, operation: 'query', query, decision: 'allow' })
    return { operation: 'query', query, csv: databaseQuery(query) }
  }
  if (options.operation === 'auth-users') {
    const value = await adminRequest(options, secrets, '/auth/v1/admin/users?page=1&per_page=100')
    return { operation: 'auth-users', users: Array.isArray(value?.users) ? value.users.map((user) => ({ id: user.id, email: user.email, phone: user.phone, createdAt: user.created_at, lastSignInAt: user.last_sign_in_at, confirmed: Boolean(user.email_confirmed_at || user.phone_confirmed_at) })) : [] }
  }
  if (options.operation === 'storage-buckets') {
    const value = await adminRequest(options, secrets, '/storage/v1/bucket')
    return { operation: 'storage-buckets', buckets: Array.isArray(value) ? value.map((bucket) => ({ id: bucket.id, name: bucket.name, public: Boolean(bucket.public), createdAt: bucket.created_at, updatedAt: bucket.updated_at })) : [] }
  }
  if (options.operation === 'functions') {
    const root = resolve(options.workspace, 'supabase/functions')
    const entries = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))
    return { operation: 'functions', functions: entries.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name)).map((entry) => ({ name: entry.name })) }
  }
  if (options.operation === 'realtime' || options.operation === 'services') {
    const names = ['api-gw', 'auth', 'db', 'rest', 'realtime', 'storage', 'functions', 'meta', 'supavisor']
    const services = names.map((name) => {
      const value = inspectContainer(containerName(name))
      return { name, status: value?.State?.Health?.Status || value?.State?.Status || 'missing', running: Boolean(value?.State?.Running) }
    })
    return { operation: options.operation, services }
  }
  if (!LOG_SERVICES.has(options.service)) fail('log service is invalid')
  return { operation: 'logs', service: options.service, log: redact(podman(['logs', '--tail', '100', containerName(options.service)], { capture: true }), secrets) }
}

function studioProxyPath(value, gatewayPort) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 12_000 || /[\u0000-\u001f\\]/.test(value)) fail('Studio proxy path is invalid')
  const base = `http://127.0.0.1:${gatewayPort}`
  let target
  try { target = new URL(value, base) } catch { fail('Studio proxy path is invalid') }
  if (target.origin !== base || !target.pathname.startsWith('/')) fail('Studio proxy path must be gateway-relative')
  return target
}

function studioProxyHeaders(value) {
  if (!value) return {}
  let decoded
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { fail('Studio proxy headers are invalid') }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail('Studio proxy headers are invalid')
  const headers = {}
  for (const [rawName, rawValue] of Object.entries(decoded)) {
    const name = rawName.toLowerCase()
    if (!STUDIO_PROXY_REQUEST_HEADERS.has(name) || typeof rawValue !== 'string' || rawValue.length > 4_096 || /[\r\n\u0000]/.test(rawValue)) continue
    headers[name] = rawValue
  }
  return headers
}

function studioProxyBody(value) {
  if (!value) return undefined
  if (typeof value !== 'string' || value.length > 5_600_000 || !/^[A-Za-z0-9_-]*$/.test(value)) fail('Studio proxy body is invalid')
  const body = Buffer.from(value, 'base64url')
  if (body.length > 4 * 1024 * 1024) fail('Studio proxy body is too large')
  return body
}

async function proxyStudioRuntime(options) {
  if (!STUDIO_PROXY_METHODS.has(options.method)) fail('Studio proxy method is invalid')
  const secrets = await loadOrCreateSecrets(options)
  const target = studioProxyPath(options.path, options.gatewayPort)
  const headers = new Headers(studioProxyHeaders(options.headersBase64))
  // The Studio Basic credential is read and used only inside the guest. It is
  // neither returned to Agent Host nor accepted from the browser request.
  headers.set('authorization', `Basic ${Buffer.from(`${secrets.DASHBOARD_USERNAME}:${secrets.DASHBOARD_PASSWORD}`).toString('base64')}`)
  const body = studioProxyBody(options.bodyBase64)
  const response = await fetch(target, {
    method: options.method,
    headers,
    redirect: 'manual',
    ...(body && !['GET', 'HEAD'].includes(options.method) ? { body } : {}),
    signal: AbortSignal.timeout(45_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 8 * 1024 * 1024) fail('Studio proxy response is too large')
  const responseHeaders = {}
  for (const [name, value] of response.headers.entries()) {
    if (!STUDIO_PROXY_RESPONSE_HEADERS.has(name.toLowerCase()) || /[\r\n\u0000]/.test(value)) continue
    if (name.toLowerCase() === 'location') {
      try {
        const location = new URL(value, target)
        if (location.origin !== target.origin) continue
        responseHeaders.location = `${location.pathname}${location.search}${location.hash}`
      } catch { }
    } else responseHeaders[name.toLowerCase()] = value
  }
  return { status: response.status, headers: responseHeaders, bodyBase64: bytes.toString('base64url') }
}

function redact(value, secrets) {
  let output = String(value)
  for (const secret of Object.entries(secrets).filter(([key]) => key !== 'projectId' && key !== 'schemaVersion' && key !== 'generatedAt').map(([, candidate]) => candidate).filter((candidate) => typeof candidate === 'string' && candidate.length >= 8)) output = output.replaceAll(secret, '[REDACTED]')
  return output
}

function inspectContainer(name) {
  try { return JSON.parse(podman(['container', 'inspect', name], { capture: true }))[0] } catch { return undefined }
}

export function containerUsesImage(container, desiredImageId) {
  if (!container || typeof container.Image !== 'string') return false
  try { return normalizeImageId(container.Image) === normalizeImageId(desiredImageId) } catch { return false }
}

async function waitReady(name, service, secrets, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const value = inspectContainer(containerName(name))
    if (!value) last = 'missing'
    else if (!value.State?.Running) last = value.State?.Error || value.State?.Status || 'not running'
    else if (!service.healthcheck) return
    else if (value.State.Health?.Status === 'healthy') return
    else if (value.State.Health?.Status === 'unhealthy') last = 'unhealthy'
    else last = value.State.Health?.Status || 'starting'
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  }
  const logs = (() => { try { return podman(['logs', '--tail', '80', containerName(name)], { capture: true }) } catch { return '' } })()
  fail(`service ${name} did not become ready (${last})${logs ? `: ${redact(logs.slice(-8_000), secrets)}` : ''}`)
}

async function ensureRuntime(options) {
  if (process.getuid?.() !== 0) fail('controller must run as root inside the Project VM')
  if (!options.explicitRuntimeRoot) options = { ...options, immutableRoot: await activeRuntimeRoot(options) }
  const lock = JSON.parse(await readFile(resolve(options.immutableRoot, 'runtime.lock.json'), 'utf8'))
  const specBytes = await readFile(resolve(options.immutableRoot, 'runtime.spec.json'))
  if (sha256(specBytes) !== lock.configuration.runtimeSpecSha256) fail('runtime spec hash does not match lock')
  const spec = validateRuntimeSpec(JSON.parse(specBytes), lock)
  await verifySeed(lock, options)
  await copyConfiguration(options, lock)
  const secrets = await loadOrCreateSecrets(options)
  const template = parseEnvTemplate(await readFile(resolve(options.immutableRoot, 'configuration/.env.example'), 'utf8'))
  const environment = projectEnvironment(template, secrets, options)
  const desiredHash = sha256(JSON.stringify({ release: lock.release, spec, environment, ports: [options.gatewayPort, options.databasePort, options.poolerPort] }))
  await ensureProjectFunctions(options)
  await ensurePaths(spec, options)
  try { podman(['network', 'inspect', NETWORK], { capture: true }) } catch { podman(['network', 'create', '--internal=false', NETWORK]) }
  for (const volume of Object.keys(spec.compose.volumes ?? {}).sort()) {
    const name = `${NETWORK}-${volume}`
    try { podman(['volume', 'inspect', name], { capture: true }) } catch { podman(['volume', 'create', name]) }
  }
  const order = dependencyOrder(spec.compose.services)
  // Reconcile all definitions before starting anything. Official Compose has
  // operational dependencies (for example Studio -> Meta -> DB) that are not
  // always represented as `depends_on`; waiting for each service immediately
  // after start would deadlock before the later dependency is even created.
  for (const name of order) {
    const service = spec.compose.services[name]
    const existing = inspectContainer(containerName(name))
    const labels = existing?.Config?.Labels ?? {}
    // Podman canonicalizes a short image name such as `supabase/postgres` to
    // `docker.io/supabase/postgres` in ImageName. Comparing those strings
    // therefore rebuilt the entire Project Supabase stack on every VM boot.
    // The locally attested immutable image ID is the real identity contract.
    const desiredImageId = podman(['image', 'inspect', '--format', '{{.Id}}', service.image], { capture: true })
    if (existing && (labels['io.openlink.project-supabase.config'] !== desiredHash || labels['io.openlink.project-supabase.revision'] !== lock.release.tag || !containerUsesImage(existing, desiredImageId))) {
      podman(['rm', '--force', containerName(name)])
    }
    if (!inspectContainer(containerName(name))) {
      podman(
        serviceCreateArgs(name, service, environment, { ...options, release: lock.release.tag, configHash: desiredHash }),
        { redactValues: Object.values(secrets) },
      )
    }
  }
  for (const name of order) {
    const current = inspectContainer(containerName(name))
    if (!current?.State?.Running) podman(['start', containerName(name)])
  }
  for (const name of order) {
    const service = spec.compose.services[name]
    await waitReady(name, service, secrets)
  }
  const state = { schemaVersion: 1, projectId: options.projectId, desiredRevision: lock.release.tag, observedRevision: lock.release.tag, status: 'ready', configHash: desiredHash, runtimeRoot: options.immutableRoot === IMMUTABLE_ROOT ? 'golden-image' : options.immutableRoot, serviceOrder: order, gatewayPort: options.gatewayPort, databasePort: options.databasePort, poolerPort: options.poolerPort, updatedAt: new Date().toISOString() }
  await atomicJson(resolve(options.stateRoot, 'runtime.json'), state)
  const publicConfig = { schemaVersion: 1, projectId: options.projectId, url: `http://127.0.0.1:${options.gatewayPort}`, publishableKey: secrets.SUPABASE_PUBLISHABLE_KEY, anonKey: secrets.ANON_KEY, revision: lock.release.tag }
  await atomicJson(resolve(options.stateRoot, 'public.json'), publicConfig, 0o640)
  return publicConfig
}

async function stopRuntime(options) {
  if (!options.explicitRuntimeRoot) options = { ...options, immutableRoot: await activeRuntimeRoot(options) }
  const lock = JSON.parse(await readFile(resolve(options.immutableRoot, 'runtime.lock.json'), 'utf8'))
  const spec = validateRuntimeSpec(JSON.parse(await readFile(resolve(options.immutableRoot, 'runtime.spec.json'))), lock)
  for (const name of dependencyOrder(spec.compose.services).reverse()) {
    if (inspectContainer(containerName(name))?.State?.Running) podman(['stop', '--time', name === 'db' ? '60' : '20', containerName(name)])
  }
}

async function removeRuntimeContainers(spec) {
  for (const name of dependencyOrder(spec.compose.services).reverse()) if (inspectContainer(containerName(name))) podman(['rm', '--force', containerName(name)])
}

async function removeManagedContainers() {
  const names = podman([
    'ps', '--all', '--filter', 'label=io.openlink.project-supabase=true',
    '--format', '{{.Names}}',
  ], { capture: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  for (const name of names) {
    if (!name.startsWith(CONTAINER_PREFIX)) fail('managed container label is attached to an unexpected container')
    podman(['rm', '--force', name])
  }
}

async function runToFile(command, args, path) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, { shell: false, stdio: ['ignore', handle.fd, 'pipe'] })
      // Drain stderr so a noisy child cannot deadlock. It may contain the
      // database connection environment, so it must never cross this process
      // boundary or be copied into the persisted lifecycle error.
      child.stderr.resume()
      child.once('error', rejectRun)
      child.once('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with ${code ?? 'unknown'}`)))
    })
  } finally {
    await handle.close()
  }
}

async function snapshotTree(source, destination) {
  await rm(destination, { recursive: true, force: true })
  try { await cp(source, destination, { recursive: true, preserveTimestamps: true }) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

async function createUpgradeBackup(options, currentState) {
  const identity = `${Date.now()}-${randomBytes(6).toString('hex')}`
  const root = resolve(options.stateRoot, 'backups', identity)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await atomicJson(resolve(root, 'metadata.json'), { schemaVersion: 1, identity, projectId: options.projectId, revision: currentState.observedRevision, runtimeRoot: currentState.runtimeRoot, createdAt: new Date().toISOString(), status: 'creating' })
  await runToFile(CONTAINER_ENGINE, ['exec', containerName('db'), 'pg_dumpall', '--username', 'postgres'], resolve(root, 'postgres.sql'))
  await stopRuntime(options)
  for (const name of ['postgres', 'storage', 'snippets']) await snapshotTree(resolve(options.stateRoot, 'data', name), resolve(root, 'data', name))
  await snapshotTree(resolve(options.workspace, 'supabase/functions'), resolve(root, 'functions'))
  await snapshotTree(resolve(options.stateRoot, 'configuration'), resolve(root, 'configuration'))
  await cp(resolve(options.stateRoot, 'secrets.json'), resolve(root, 'secrets.json'))
  await atomicJson(resolve(root, 'metadata.json'), { schemaVersion: 1, identity, projectId: options.projectId, revision: currentState.observedRevision, runtimeRoot: currentState.runtimeRoot, createdAt: new Date().toISOString(), status: 'ready' })
  return { identity, root }
}

async function restoreUpgradeBackup(options, backup, previousRoot) {
  validateRuntimeSpec(JSON.parse(await readFile(resolve(previousRoot, 'runtime.spec.json'))))
  await removeManagedContainers()
  for (const name of ['postgres', 'storage', 'snippets']) await snapshotTree(resolve(backup.root, 'data', name), resolve(options.stateRoot, 'data', name))
  await snapshotTree(resolve(backup.root, 'functions'), resolve(options.workspace, 'supabase/functions'))
  await snapshotTree(resolve(backup.root, 'configuration'), resolve(options.stateRoot, 'configuration'))
  await cp(resolve(backup.root, 'secrets.json'), resolve(options.stateRoot, 'secrets.json'))
  const metadata = JSON.parse(await readFile(resolve(backup.root, 'metadata.json'), 'utf8'))
  if (metadata.runtimeRoot === 'golden-image') await rm(resolve(options.stateRoot, 'active-release.json'), { force: true })
  else await atomicJson(resolve(options.stateRoot, 'active-release.json'), { release: metadata.revision, root: previousRoot })
  await ensureRuntime({ ...options, immutableRoot: previousRoot, explicitRuntimeRoot: true })
  await atomicJson(resolve(backup.root, 'metadata.json'), { ...metadata, status: 'restored', restoredAt: new Date().toISOString() })
}

async function installUpgradeBundle(options, bundleRoot, targetLock) {
  const destination = releaseDirectory(options.stateRoot, targetLock.release.tag)
  const temporary = `${destination}.${process.pid}.tmp`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(bundleRoot, temporary, { recursive: true, preserveTimestamps: true })
  await rm(destination, { recursive: true, force: true })
  await rename(temporary, destination)
  return destination
}

async function upgradeRuntime(options) {
  const bundleRoot = resolve(options.bundle || '')
  if (!options.bundle || !bundleRoot.startsWith('/')) fail('upgrade bundle must be an absolute path')
  const currentState = JSON.parse(await readFile(resolve(options.stateRoot, 'runtime.json'), 'utf8'))
  if (currentState.status !== 'ready' || currentState.projectId !== options.projectId) fail('Project Supabase must be ready before upgrade')
  const previousRoot = await activeRuntimeRoot(options)
  const targetLock = JSON.parse(await readFile(resolve(bundleRoot, 'runtime.lock.json'), 'utf8'))
  const targetSpecBytes = await readFile(resolve(bundleRoot, 'runtime.spec.json'))
  if (sha256(targetSpecBytes) !== targetLock.configuration.runtimeSpecSha256) fail('target runtime spec hash does not match target lock')
  validateRuntimeSpec(JSON.parse(targetSpecBytes), targetLock)
  const gates = upgradeGates(currentState.observedRevision, targetLock)
  if (gates.some((gate) => gate.gate)) fail(`upgrade requires unsupported migration gate ${gates.find((gate) => gate.gate).gate}`)
  if (gates.some((gate) => gate.breaking) && !options.acceptBreaking) fail('upgrade crosses a breaking Supabase release and requires explicit acceptance')
  const verifiedBundle = await verifyUpgradeBundle(bundleRoot, targetLock, options)
  const capacity = await preflightUpgradeCapacity(options, verifiedBundle.imageManifest)
  const importedImages = await importUpgradeImages(bundleRoot, targetLock, verifiedBundle.imageManifest)
  // verifySeed performs a second independent check against the target lock and
  // local Podman image IDs after imports have completed.
  await verifySeed(targetLock, { ...options, immutableRoot: bundleRoot })
  const targetRoot = await installUpgradeBundle(options, bundleRoot, targetLock)
  await atomicJson(resolve(options.stateRoot, 'runtime.json'), { ...currentState, desiredRevision: targetLock.release.tag, status: 'upgrading', upgradeStartedAt: new Date().toISOString() })
  let backup
  try {
    backup = await createUpgradeBackup(options, currentState)
  } catch (backupError) {
    // A failed backup has not modified persistent project data. The backup
    // helper may already have stopped services, so restore availability before
    // reporting failure and leave the observed revision unchanged.
    try {
      await ensureRuntime({ ...options, immutableRoot: previousRoot, explicitRuntimeRoot: true })
      await atomicJson(resolve(options.stateRoot, 'runtime.json'), { ...currentState, status: 'ready', updatedAt: new Date().toISOString() })
    } catch (restartError) {
      await atomicJson(resolve(options.stateRoot, 'runtime.json'), { ...currentState, desiredRevision: targetLock.release.tag, status: 'upgrade_failed', failurePhase: 'backup', updatedAt: new Date().toISOString() })
      throw new AggregateError([backupError, restartError], 'Project Supabase upgrade backup failed and the current release could not be restarted')
    }
    throw new Error(`Project Supabase runtime: upgrade backup failed; current release was restarted`)
  }
  try {
    await removeManagedContainers()
    await atomicJson(resolve(options.stateRoot, 'active-release.json'), { release: targetLock.release.tag, root: targetRoot })
    const publicConfig = await ensureRuntime({ ...options, immutableRoot: targetRoot, explicitRuntimeRoot: true })
    const metadata = JSON.parse(await readFile(resolve(backup.root, 'metadata.json'), 'utf8'))
    await atomicJson(resolve(backup.root, 'metadata.json'), { ...metadata, status: 'committed', committedAt: new Date().toISOString() })
    return { ...publicConfig, backupId: backup.identity, importedImages, capacity }
  } catch (upgradeError) {
    let restoreError
    try {
      await restoreUpgradeBackup(options, backup, previousRoot)
    } catch (error) {
      restoreError = error
    }
    if (restoreError) {
      await atomicJson(resolve(options.stateRoot, 'runtime.json'), { ...currentState, desiredRevision: targetLock.release.tag, status: 'upgrade_failed', backupId: backup.identity, updatedAt: new Date().toISOString() })
      throw new AggregateError([upgradeError, restoreError], `Project Supabase upgrade and rollback failed; backup ${backup.identity}`)
    }
    throw new Error(`Project Supabase runtime: upgrade failed and was rolled back; backup ${backup.identity}`)
  }
}

function numberOption(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535) fail(`${label} is invalid`)
  return parsed
}

export function parseOptions(argv) {
  const [command, ...rest] = argv
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith('--') || value === undefined) fail(`invalid argument ${key ?? ''}`)
    values[key.slice(2)] = value
  }
  const options = {
    command,
    projectId: values['project-id'],
    workspace: resolve(values.workspace || '/workspace'),
    stateRoot: resolve(values['state-root'] || STATE_ROOT),
    immutableRoot: resolve(values['immutable-root'] || IMMUTABLE_ROOT),
    gatewayPort: numberOption(values['gateway-port'] || '54321', 'gateway port'),
    databasePort: numberOption(values['database-port'] || '54322', 'database port'),
    poolerPort: numberOption(values['pooler-port'] || '54323', 'pooler port'),
    siteUrl: values['site-url'] || 'http://localhost:3000',
    additionalRedirectUrls: values['additional-redirect-urls'] || '',
    releaseTrust: values['release-trust'] ? resolve(values['release-trust']) : RELEASE_TRUST,
    bundle: values.bundle,
    operation: values.operation,
    query: values.query,
    service: values.service,
    mode: normalizeAccessMode(values.mode),
    method: values.method,
    path: values.path,
    headersBase64: values['headers-base64'],
    bodyBase64: values['body-base64'],
    acceptBreaking: values['accept-breaking'] === 'true',
    explicitRuntimeRoot: false,
  }
  if (!['ensure', 'stop', 'status', 'public', 'manage', 'studio-proxy', 'upgrade'].includes(command)) fail('command must be ensure, stop, status, public, manage, studio-proxy or upgrade')
  if (!/^[a-f0-9-]{36}$/i.test(options.projectId || '')) fail('project id is invalid')
  return options
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const mutating = ['ensure', 'stop', 'upgrade'].includes(options.command)
  const releaseLock = mutating ? await acquireLifecycleLock(options.stateRoot, options.command) : undefined
  let value
  try {
    if (options.command === 'ensure') value = await ensureRuntime(options)
    else if (options.command === 'stop') { await stopRuntime(options); value = { stopped: true } }
    else if (options.command === 'upgrade') value = await upgradeRuntime(options)
    else if (options.command === 'status') value = JSON.parse(await readFile(resolve(options.stateRoot, 'runtime.json'), 'utf8'))
    else if (options.command === 'manage') value = await manageRuntime(options)
    else if (options.command === 'studio-proxy') value = await proxyStudioRuntime(options)
    else value = JSON.parse(await readFile(resolve(options.stateRoot, 'public.json'), 'utf8'))
    process.stdout.write(`${JSON.stringify(value)}\n`)
  } finally {
    await releaseLock?.()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
