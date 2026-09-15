import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function fixture({ state = 'active', verified = true, revoked = true, failure = null } = {}) {
  class CloudConnectionError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code } }
  let checks = 0, disconnects = 0
  const modules = {
    CloudConnectionError,
    getCloudConnection: async () => {
      if (failure) throw failure === 'unauthenticated' ? new CloudConnectionError(401, 'AUTHENTICATION_REQUIRED') : new Error('private-token-material')
      return { state, sdk: { verifyIdentity: async () => {
        checks++; if (!verified) throw new Error('private-token-material')
        return { sub: 'cloud-subject', accessToken: 'private-token-material' }
      } } }
    },
    disconnectCloudConnection: async () => { disconnects++; return { revoked, revocationPending: !revoked } },
  }
  const source = readFileSync(new URL('../../app/api/platform/connections/[connectionId]/route.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('require', 'exports', 'process', code)(() => modules, exports, { env: { OPENLINK_APP_URL: 'https://openlink.example' } })
  return { exports, counts: () => ({ checks, disconnects }) }
}
const context = { params: Promise.resolve({ connectionId: 'opaque-id' }) }

test('connection GET verifies remote identity and emits no credential material', async () => {
  const f = fixture()
  const response = await f.exports.GET(new Request('https://openlink.example/api'), context)
  assert.deepEqual(await response.json(), { connected: true, subject: 'cloud-subject' })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(f.counts().checks, 1)
})
test('inactive connection is not represented as authenticated', async () => {
  for (const state of ['revoking', 'revoked', 'reauth_required']) {
    const f = fixture({ state })
    assert.deepEqual(await (await f.exports.GET(new Request('https://openlink.example/api'), context)).json(), { connected: false, state })
    assert.equal(f.counts().checks, 0)
  }
})
test('authentication and dependency failures remain failures with redacted bodies', async () => {
  for (const [options, status] of [[{ failure: 'unauthenticated' }, 401], [{ failure: 'server' }, 503], [{ verified: false }, 503]]) {
    const response = await fixture(options).exports.GET(new Request('https://openlink.example/api'), context)
    assert.equal(response.status, status)
    assert.ok(!(await response.text()).includes('private-token-material'))
  }
})
test('disconnect requires the owned origin before any mutation', async () => {
  const f = fixture()
  for (const origin of [null, 'https://attacker.example', 'https://openlink.example.attacker.test']) {
    const request = new Request('https://openlink.example/api', { method: 'DELETE', headers: origin ? { origin } : {} })
    assert.equal((await f.exports.DELETE(request, context)).status, 403)
  }
  assert.equal(f.counts().disconnects, 0)
})
test('remote revocation failure is pending, not successful cleanup', async () => {
  for (const revoked of [true, false]) {
    const f = fixture({ revoked })
    const response = await f.exports.DELETE(new Request('https://openlink.example/api', { method: 'DELETE', headers: { origin: 'https://openlink.example' } }), context)
    assert.equal(response.status, revoked ? 200 : 202)
    assert.deepEqual(await response.json(), { revoked, revocationPending: !revoked })
  }
})
