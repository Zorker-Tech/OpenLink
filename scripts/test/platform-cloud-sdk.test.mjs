import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryOAuthTokenStore } from '@vtslx/platform-sdk/auth'
import { createOpenLinkCloudSdk } from '../../lib/platform-cloud-sdk.ts'

const user = '00000000-0000-4000-8000-000000000001'
const applicationProject = '00000000-0000-4000-8000-000000000002'
const platformProject = '00000000-0000-4000-8000-000000000003'
const binding = { openlinkUserId: user, openlinkProjectId: applicationProject, platformProjectRef: platformProject }

async function fixture(subject = 'hydite-user') {
  const store = new MemoryOAuthTokenStore()
  await store.save({ accessToken: 'placeholder-token', tokenType: 'Bearer', scope: ['openid', 'computer:write'], expiresAt: Date.now() + 60000 })
  const calls = []
  const fetcher = async (input, options) => {
    const url = String(input)
    calls.push({ url, options })
    if (url.includes('.well-known')) return Response.json({
      issuer: 'https://auth.hydite.com', authorization_endpoint: 'https://auth.hydite.com/authorize',
      token_endpoint: 'https://auth.hydite.com/token', userinfo_endpoint: 'https://auth.hydite.com/userinfo',
      code_challenge_methods_supported: ['S256'],
    })
    if (url.endsWith('/userinfo')) return Response.json({ sub: subject })
    if (url.endsWith('/api/v1/projects')) return Response.json({ data: [{ id: platformProject, name: 'Cloud', organization_id: user }] })
    return Response.json({ status: 'sleeping' })
  }
  const options = { mode: 'cloud', openlinkUserId: user, hyditeSubject: 'hydite-user',
    clientId: 'openlink-cloud-test', redirectUri: 'https://openlink.example/auth/platform/callback',
    tokenStore: store, refreshCoordinator: { runExclusive: operation => operation() }, fetch: fetcher }
  return { options, calls }
}

test('Local cannot construct cloud identity or touch the network', async () => {
  const { options, calls } = await fixture()
  assert.throws(() => createOpenLinkCloudSdk({ ...options, mode: 'local' }), /Local mode/)
  assert.equal(calls.length, 0)
})

test('Cloud requires explicit identity and token persistence boundaries', async () => {
  const { options } = await fixture()
  assert.throws(() => createOpenLinkCloudSdk({ ...options, tokenStore: undefined }), /token store/)
  assert.throws(() => createOpenLinkCloudSdk({ ...options, refreshCoordinator: undefined }), /coordinator/)
  assert.throws(() => createOpenLinkCloudSdk({ ...options, openlinkUserId: 'unknown' }), /identity binding/)
})

test('Cloud uses the external project ref, not the application project ID', async () => {
  const { options, calls } = await fixture()
  const client = createOpenLinkCloudSdk(options)
  const project = await client.project(binding)
  assert.equal(project.computer.projectRef, platformProject)
  assert.deepEqual(await project.computer.info(), { status: 'sleeping' })
  const request = calls.find(call => call.url.endsWith('/computer/info'))
  assert.ok(request.url.includes('/projects/' + platformProject + '/openlink/'))
  assert.ok(!request.url.includes(applicationProject))
  assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer placeholder-token')
  const workspace = await client.workspace(binding)
  assert.equal(typeof workspace.create, 'function')
  assert.equal('codePlan' in client, false)
})

test('userinfo subject mismatch stops directory and project access', async () => {
  const { options, calls } = await fixture('other-user')
  const client = createOpenLinkCloudSdk(options)
  await assert.rejects(client.project(binding), /subject mismatch/)
  await assert.rejects(client.listProjects(), /subject mismatch/)
  assert.ok(calls.every(call => call.url.includes('.well-known') || call.url.endsWith('/userinfo')))
})

test('cross-user and malformed project bindings fail before network access', async () => {
  const { options, calls } = await fixture()
  const client = createOpenLinkCloudSdk(options)
  await assert.rejects(client.workspace({ ...binding, openlinkUserId: applicationProject }), /binding/)
  await assert.rejects(client.workspace({ ...binding, platformProjectRef: '../admin' }), /binding/)
  assert.equal(calls.length, 0)
})

test('Cloud project discovery requires confirmed linked identity', async () => {
  const { options, calls } = await fixture()
  const projects = await createOpenLinkCloudSdk(options).listProjects()
  assert.equal(projects[0].id, platformProject)
  assert.ok(calls.findIndex(call => call.url.endsWith('/userinfo')) < calls.findIndex(call => call.url.endsWith('/api/v1/projects')))
})
