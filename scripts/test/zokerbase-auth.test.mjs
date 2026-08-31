import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import test from 'node:test'
import { enableZokerbaseModernAuthCompose, generateZokerbaseModernAuth, generateZokerbaseSecrets } from '../lib/zokerbase-auth.mjs'

function payload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

test('fresh ZOKERBASE secrets preserve the complete upstream credential set and valid legacy JWTs', () => {
  const values = generateZokerbaseSecrets()
  for (const key of ['JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'VAULT_ENC_KEY', 'PG_META_CRYPTO_KEY', 'LOGFLARE_PUBLIC_ACCESS_TOKEN', 'LOGFLARE_PRIVATE_ACCESS_TOKEN', 'S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET', 'MINIO_ROOT_PASSWORD', 'POSTGRES_PASSWORD', 'DASHBOARD_PASSWORD']) {
    assert.ok(values[key], `${key} is required`)
  }
  assert.equal(payload(values.ANON_KEY).role, 'anon')
  assert.equal(payload(values.SERVICE_ROLE_KEY).role, 'service_role')
})

test('modern auth produces verifiable ES256 JWTs, private/public JWKS and opaque API keys', () => {
  const jwtSecret = 'a'.repeat(40)
  const values = generateZokerbaseModernAuth(jwtSecret)
  assert.match(values.SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_.+_[A-Za-z0-9_-]{8}$/)
  assert.match(values.SUPABASE_SECRET_KEY, /^sb_secret_.+_[A-Za-z0-9_-]{8}$/)
  const privateKeys = JSON.parse(values.JWT_KEYS)
  const publicKeys = JSON.parse(values.JWT_JWKS).keys
  assert.equal(privateKeys.length, 2)
  assert.equal(publicKeys.length, 2)
  assert.ok(privateKeys[0].d)
  assert.equal(publicKeys[0].d, undefined)
  const [header, body, signature] = values.ANON_KEY_ASYMMETRIC.split('.')
  assert.equal(verify('SHA256', Buffer.from(`${header}.${body}`), { key: createPublicKey({ key: publicKeys[0], format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true)
})

test('Compose asymmetric auth wiring is enabled completely or fails closed', () => {
  const commented = ['  #GOTRUE_JWT_KEYS: value', '  #API_JWT_JWKS: value', '  #JWT_JWKS: value', '  #SUPABASE_JWKS: value'].join('\n')
  const enabled = enableZokerbaseModernAuthCompose(commented)
  assert.doesNotMatch(enabled, /#(?:GOTRUE_JWT_KEYS|API_JWT_JWKS|JWT_JWKS|SUPABASE_JWKS)/)
  assert.throws(() => enableZokerbaseModernAuthCompose('services: {}'), /does not expose required/)
})
