import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'

function jwtInput(header, payload) {
  return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

function hs256(secret, payload) {
  const input = jwtInput({ alg: 'HS256', typ: 'JWT' }, payload)
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
}

function es256(privateKey, kid, payload) {
  const input = jwtInput({ alg: 'ES256', typ: 'JWT', kid }, payload)
  const signature = sign('SHA256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${input}.${signature.toString('base64url')}`
}

function lifetime(now = Date.now()) {
  const iat = Math.floor(now / 1000)
  return { iat, exp: iat + 5 * 365 * 24 * 60 * 60 }
}

/** Equivalent to the reviewed upstream generate-keys.sh output, without a POSIX shell dependency. */
export function generateZokerbaseSecrets(options = {}) {
  const jwtSecret = (options.randomBytes ?? randomBytes)(30).toString('base64')
  const time = lifetime(options.now?.() ?? Date.now())
  return {
    JWT_SECRET: jwtSecret,
    ANON_KEY: hs256(jwtSecret, { role: 'anon', iss: 'supabase', ...time }),
    SERVICE_ROLE_KEY: hs256(jwtSecret, { role: 'service_role', iss: 'supabase', ...time }),
    SECRET_KEY_BASE: (options.randomBytes ?? randomBytes)(48).toString('base64'),
    REALTIME_DB_ENC_KEY: (options.randomBytes ?? randomBytes)(8).toString('hex'),
    VAULT_ENC_KEY: (options.randomBytes ?? randomBytes)(16).toString('hex'),
    PG_META_CRYPTO_KEY: (options.randomBytes ?? randomBytes)(24).toString('base64'),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: (options.randomBytes ?? randomBytes)(24).toString('base64'),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: (options.randomBytes ?? randomBytes)(24).toString('base64'),
    S3_PROTOCOL_ACCESS_KEY_ID: (options.randomBytes ?? randomBytes)(16).toString('hex'),
    S3_PROTOCOL_ACCESS_KEY_SECRET: (options.randomBytes ?? randomBytes)(32).toString('hex'),
    MINIO_ROOT_PASSWORD: (options.randomBytes ?? randomBytes)(16).toString('hex'),
    POSTGRES_PASSWORD: (options.randomBytes ?? randomBytes)(16).toString('hex'),
    DASHBOARD_PASSWORD: (options.randomBytes ?? randomBytes)(16).toString('hex'),
  }
}

function opaqueKey(prefix, random = randomBytes) {
  const body = `${prefix}${random(17).toString('base64url').slice(0, 22)}`
  const checksum = createHash('sha256').update(`supabase-self-hosted|${body}`).digest('base64url').slice(0, 8)
  return `${body}_${checksum}`
}

/** Equivalent to add-new-auth-keys.sh: P-256 signing JWKs, ES256 JWTs and checksummed opaque keys. */
export function generateZokerbaseModernAuth(jwtSecret, options = {}) {
  if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) throw new Error('ZOKERBASE JWT secret must be at least 32 characters')
  const { privateKey } = (options.generateKeyPairSync ?? generateKeyPairSync)('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  const kid = (options.randomUUID ?? randomUUID)()
  const symmetric = { kty: 'oct', k: Buffer.from(jwtSecret).toString('base64url'), alg: 'HS256' }
  const privateJwk = { kty: 'EC', kid, use: 'sig', key_ops: ['sign', 'verify'], alg: 'ES256', ext: true, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }
  const publicJwk = { kty: 'EC', kid, use: 'sig', key_ops: ['verify'], alg: 'ES256', ext: true, crv: jwk.crv, x: jwk.x, y: jwk.y }
  const time = lifetime(options.now?.() ?? Date.now())
  return {
    SUPABASE_PUBLISHABLE_KEY: opaqueKey('sb_publishable_', options.randomBytes ?? randomBytes),
    SUPABASE_SECRET_KEY: opaqueKey('sb_secret_', options.randomBytes ?? randomBytes),
    ANON_KEY_ASYMMETRIC: es256(privateKey, kid, { role: 'anon', iss: 'supabase', ...time }),
    SERVICE_ROLE_KEY_ASYMMETRIC: es256(privateKey, kid, { role: 'service_role', iss: 'supabase', ...time }),
    JWT_KEYS: JSON.stringify([privateJwk, symmetric]),
    JWT_JWKS: JSON.stringify({ keys: [publicJwk, symmetric] }),
  }
}

export function enableZokerbaseModernAuthCompose(contents) {
  const keys = ['GOTRUE_JWT_KEYS', 'API_JWT_JWKS', 'JWT_JWKS', 'SUPABASE_JWKS']
  let next = contents
  for (const key of keys) next = next.replace(new RegExp(`^(\\s*)#${key}:`, 'gm'), `$1${key}:`)
  for (const key of keys) {
    if (!new RegExp(`^\\s*${key}:`, 'm').test(next)) throw new Error(`ZOKERBASE Compose stack does not expose required ${key} authentication configuration`)
  }
  return next
}
