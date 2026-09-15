import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import ts from 'typescript'
import { MemoryOAuthTokenStore } from '@vtslx/platform-sdk/auth'
import { createOpenLinkCloudSdk } from '../../lib/platform-cloud-sdk.ts'
import { CloudOAuthVault, cloudConnectionCommand } from '../../lib/platform-cloud-vault.ts'
import { createCloudCredentialCipher, createCloudLoginCipher, createCloudRevocationSigner } from '../../lib/platform-cloud-crypto.ts'

const user = '00000000-0000-4000-8000-000000000001', id = '00000000-0000-4000-8000-000000000003'
function fixture({ mode = 'cloud', authenticated = true, remoteFails = false, configured = true } = {}) {
  const key = randomBytes(32), calls = []
  const cipher = createCloudCredentialCipher(new Map([['k1', key]]), 'k1')
  const record = { id, user_id: user, issuer: 'https://auth.hydite.com', subject: 'hydite-user', client_id: 'old-client',
    revision: 1, state: 'active', lease_until: null, envelope: null }
  record.envelope = cipher.seal({ accessToken: 'synthetic-private-access', refreshToken: 'synthetic-private-refresh', tokenType: 'Bearer', scope: ['openid'], expiresAt: Date.now() + 60000 }, record)
  const modules = {
    'server-only': {},
    '@vtslx/platform-sdk/auth': { MemoryOAuthTokenStore, PlatformAuthClient: class {
      constructor(options) { this.options = options }
      async revoke() {
        calls.push('remote-revoke')
        assert.equal(record.state, 'revoking')
        assert.equal(this.options.clientId, 'old-client')
        try {
          assert.equal((await this.options.tokenStore.load()).refreshToken, 'synthetic-private-refresh')
          if (remoteFails) throw new Error('synthetic-private-error')
        } finally { await this.options.tokenStore.clear() }
      }
    } },
    '@/utils/supabase/server': { createClient: async () => {
      calls.push('create-client')
      return { auth: { getUser: async () => ({ data: { user: authenticated ? { id: user } : null }, error: null }) },
        schema: () => ({ rpc: async (_name, args) => {
          calls.push(args.p_operation)
          if (args.p_operation === 'list') return { data: { outcome: 'listed', connections: [structuredClone(record)] }, error: null }
          if (args.p_connection_id !== id) return { data: { outcome: 'missing' }, error: null }
          if (args.p_operation === 'disconnect') record.state = 'revoking'
          if (args.p_operation === 'ack_revoke') { record.state = 'revoked'; record.envelope = null }
          return { data: { outcome: args.p_operation === 'disconnect' ? 'disconnected' : args.p_operation === 'ack_revoke' ? 'revoked' : 'loaded', record: structuredClone(record) }, error: null }
        } }) }
    } },
    '@/lib/runtime-mode.server': { getRuntimeMode: () => mode },
    '@/lib/platform-cloud-sdk': { createOpenLinkCloudSdk },
    '@/lib/platform-cloud-crypto': { createCloudCredentialCipher, createCloudLoginCipher, createCloudRevocationSigner },
    '@/lib/platform-cloud-vault': { CloudOAuthVault, cloudConnectionCommand },
  }
  const env = { OPENLINK_APP_URL: 'https://openlink.example', OPENLINK_CLOUD_OAUTH_CLIENT_ID: 'new-client',
    ...(configured ? { OPENLINK_CLOUD_OAUTH_KEYRING: JSON.stringify({ active: 'k1', keys: { k1: key.toString('base64') } }),
      OPENLINK_CLOUD_OAUTH_REVOCATION_KEY: JSON.stringify({ id: 'receipt-1', key: randomBytes(32).toString('base64') }) } : {}) }
  const source = readFileSync(new URL('../../lib/platform-cloud-connection.server.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('require', 'exports', 'process', code)(name => { if (!(name in modules)) throw new Error('Unexpected import'); return modules[name] }, exports, { env })
  return { exports, calls, record }
}

test('server integration refuses Local before constructing any data client', async () => {
  const f = fixture({ mode: 'local' })
  await assert.rejects(f.exports.listCloudConnections(), error => error.status === 404)
  assert.equal(f.calls.length, 0)
})
test('server integration authenticates the application user before vault access', async () => {
  const f = fixture({ authenticated: false })
  await assert.rejects(f.exports.getCloudConnection(id), error => error.status === 401)
  assert.deepEqual(f.calls, ['create-client'])
})
test('connection summaries cannot disclose future RPC envelope fields', async () => {
  const f = fixture()
  const summaries = await f.exports.listCloudConnections()
  assert.deepEqual(Object.keys(summaries[0]).sort(), ['id', 'issuer', 'state', 'subject'])
  assert.ok(!JSON.stringify(summaries).includes('ciphertext'))
})
test('server keeps the sealed existing client binding during client configuration rotation', async () => {
  const f = fixture()
  const { sdk, vault } = await f.exports.getCloudConnection(id)
  assert.equal(sdk.auth.clientId, 'old-client')
  assert.equal((await vault.load()).refreshToken, 'synthetic-private-refresh')
})
test('missing keyring has no Local fallback and does not leak key material', async () => {
  const f = fixture({ configured: false })
  await assert.rejects(f.exports.getCloudConnection(id), error => error.status === 503 && error.code === 'CLOUD_CONNECTION_NOT_CONFIGURED')
  assert.ok(!f.calls.includes('remote-revoke'))
})
test('disconnect fences storage before remote work and only then acknowledges cleanup', async () => {
  for (const remoteFails of [false, true]) {
    const f = fixture({ remoteFails })
    const result = await f.exports.disconnectCloudConnection(id)
    assert.equal(result.revoked, !remoteFails)
    assert.ok(f.calls.indexOf('disconnect') < f.calls.indexOf('remote-revoke'))
    assert.equal(f.calls.includes('ack_revoke'), !remoteFails)
    assert.equal(f.record.state, remoteFails ? 'revoking' : 'revoked')
    assert.equal(f.record.envelope === null, !remoteFails)
  }
})
