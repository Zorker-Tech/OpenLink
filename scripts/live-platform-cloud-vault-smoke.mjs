import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { MemoryOAuthTokenStore, PlatformAuthClient, registerOAuthPublicClient } from '@vtslx/platform-sdk/auth'
import { CloudOAuthVault, cloudConnectionCommand } from '../lib/platform-cloud-vault.ts'
import { createCloudCredentialCipher, createCloudLoginCipher } from '../lib/platform-cloud-crypto.ts'
import { createOpenLinkCloudSdk } from '../lib/platform-cloud-sdk.ts'
import { beginCloudLogin, finishCloudLogin, parseCloudLoginCallback, cloudLoginCookie } from '../lib/platform-cloud-login.ts'

// Real Cloud Auth/PostgREST and public OAuth, no local database/server substitute.
// Only the designated account; passwords, tokens and encryption keys stay in memory.
const expectedUser = '4d59a5c9-3489-49eb-927f-df592279ec7b'
const env = parseEnv(readFileSync(new URL('../.env.local', import.meta.url), 'utf8'))
const pool = env.OPENLINK_CLOUD_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
const publicKey = env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
assert.equal(new URL(pool).origin, 'https://pool.hydite.com')
if (!publicKey.startsWith('sb_publishable_')) assert.equal(JSON.parse(Buffer.from(publicKey.split('.')[1], 'base64url')).role, 'anon')
const issuer = 'https://auth.hydite.com'
const report = (check, details = {}) => console.log(JSON.stringify({ check, ...details }))
let refreshRequests = 0
const request = async (url, init = {}) => {
  if (new URL(String(url)).origin === issuer && new URLSearchParams(String(init.body ?? '')).get('grant_type') === 'refresh_token') refreshRequests++
  return fetch(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(20000) })
}
const db = createClient(pool, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: request } })
let phase = 'input', clientId, bootstrap, vault, command, loggedIn = false, failed = false
let connectionId = randomUUID(), loginId

async function hiddenInput(check = 'awaiting_hidden_credential_json') {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  report(check)
  return new Promise((resolve, reject) => {
    let buffer = ''
    const receive = chunk => {
      buffer += chunk
      if (buffer.length > 4096) { process.stdin.off('data', receive); reject(new Error('input bound')); return }
      if (/[\r\n]/.test(buffer)) {
        process.stdin.off('data', receive); process.stdin.pause()
        try { resolve(JSON.parse(buffer.trim())) } catch { reject(new Error('invalid input')) }
        buffer = ''
      }
    }
    process.stdin.on('data', receive)
    process.stdin.resume()
  })
}
try {
  const credentials = await hiddenInput()
  assert.equal(credentials.email, 'yikewang@info.hydite.com')
  phase = 'real_cloud_data_login'
  const { data, error } = await db.auth.signInWithPassword(credentials)
  credentials.password = ''
  assert.equal(error, null)
  assert.equal(data.user.id, expectedUser)
  loggedIn = true
  command = cloudConnectionCommand(db)
  const current = await command('list', null)
  assert.ok(!current.connections.some(row => ['active', 'refreshing', 'reauth_required'].includes(row.state)), 'Do not replace an existing user connection')
  report(phase, { identityMatched: true })

  phase = 'real_oauth_link'
  const scopes = ['openid', 'profile', 'email', 'computer:read', 'computer:write']
  const registration = await registerOAuthPublicClient({ issuer, clientName: 'OpenLink Cloud vault smoke ' + new Date().toISOString(),
    redirectUris: ['http://127.0.0.1:48174/callback'], scopes, fetch: request })
  clientId = registration.clientId
  report('test_oauth_client', { clientId })
  const initialStore = new MemoryOAuthTokenStore()
  const keyring = new Map([['smoke', randomBytes(32)]])
  const cipher = createCloudCredentialCipher(keyring, 'smoke')
  const optionsFor = id => ({ mode: 'cloud', userId: expectedUser, connectionId:id, subject: expectedUser, clientId, command, cipher,
    signRevocation: async record => {
      report('server_revocation_receipt_required', { connectionId:id, userId: expectedUser, revision: record.revision })
      return hiddenInput('awaiting_hidden_revocation_receipt')
    } })
  const consent = async url => {
    const response = await request(issuer + '/api/auth/oauth/authorize', { method:'POST',
      headers:{authorization:'Bearer '+data.session.access_token,origin:issuer,'content-type':'application/json'},
      body:JSON.stringify(Object.fromEntries(new URL(url).searchParams)) })
    assert.equal(response.status,200)
    const callback=new URL((await response.json()).redirect_url)
    assert.equal(callback.origin,'http://127.0.0.1:48174')
    return callback
  }
  let tokens
  if (process.argv.includes('--login-transaction')) {
    phase='real_database_pkce_callback'
    const login={userId:expectedUser,clientId,redirectUri:registration.redirectUris[0],cipher:createCloudLoginCipher(keyring,'smoke'),fetch:request,
      command:async(operation,id,payload)=>{
        const result=await db.schema('openlink').rpc('cloud_oauth_login_command',{p_operation:operation,p_login_id:id,p_payload:payload})
        if(result.error) throw new Error('Cloud login RPC failed')
        return result.data
      }}
    const pending=await beginCloudLogin(login)
    loginId=pending.cookieValue.split('.')[0]
    report('test_login_transaction',{clientId,loginId})
    const callback=await consent(pending.authorizationUrl)
    const parsed=parseCloudLoginCallback(new Request(callback,{headers:{cookie:cloudLoginCookie+'='+pending.cookieValue}}))
    const completed=await finishCloudLogin(login,parsed,async input=>{
      assert.equal(input.subject,expectedUser)
      connectionId=input.connectionId;tokens=input.tokens
      report('test_resources',{clientId,connectionId,loginId})
      vault=new CloudOAuthVault(optionsFor(connectionId))
      await vault.create(tokens)
    })
    assert.equal(completed.connected,true)
    await assert.rejects(finishCloudLogin(login,parsed,async()=>{throw new Error('replay must not persist')}),/CONSUMED/)
    report(phase,{subjectMatched:true,oneUseConsumption:true,connectionPersisted:true,browserUIVerified:false})
  } else {
    bootstrap = new PlatformAuthClient({ issuer, clientId, redirectUri: registration.redirectUris[0], scopes, tokenStore: initialStore, fetch: request })
    const authorization = await bootstrap.createAuthorizationRequest()
    const callback=await consent(authorization.url)
    assert.equal(callback.searchParams.get('state'),authorization.state)
    tokens=await bootstrap.exchangeAuthorizationCode({code:callback.searchParams.get('code'),codeVerifier:authorization.codeVerifier})
    assert.equal((await bootstrap.userInfo({expectedSubject:expectedUser})).sub,expectedUser)
    report('test_resources',{clientId,connectionId})
    vault=new CloudOAuthVault(optionsFor(connectionId))
    await vault.create(tokens)
    report(phase,{subjectMatched:true})
  }
  phase = 'real_encrypted_connection_persistence'
  const options=optionsFor(connectionId)
  await initialStore.clear()
  const persisted = await command('load', connectionId)
  assert.equal(persisted.record.state, 'active')
  assert.ok(!JSON.stringify(persisted).includes(tokens.refreshToken))
  const anon = createClient(pool, publicKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: request } })
  const denial = await anon.schema('openlink').rpc('cloud_oauth_connection_command', { p_operation: 'load', p_connection_id: connectionId, p_payload: {} })
  assert.ok(denial.error)
  report(phase, { revision: persisted.record.revision, encrypted: true, anonymousDenied: true })

  phase = 'real_cross_instance_refresh_coordination'
  const a = new CloudOAuthVault(options), b = new CloudOAuthVault(options)
  const product = store => createOpenLinkCloudSdk({ mode: 'cloud', openlinkUserId: expectedUser, hyditeSubject: expectedUser,
    clientId, redirectUri: registration.redirectUris[0], tokenStore: store, refreshCoordinator: store, fetch: request })
  const first = product(a), second = product(b)
  const results = await Promise.all([first.auth.refresh(), second.auth.refresh()])
  assert.equal(refreshRequests, 1)
  assert.equal(results[0].accessToken, results[1].accessToken)
  assert.equal(results[0].refreshToken, results[1].refreshToken)
  assert.equal((await command('load', connectionId)).record.revision, 2)
  report(phase, { sdkInstances: 2, refreshRequests, sameResult: true, revision: 2 })
  assert.equal((await first.verifyIdentity()).sub, expectedUser)
  const projects = await first.listProjects()
  assert.ok(projects.length > 0)
  report('real_openlink_adapter_directory', { projectCount: projects.length, subjectMatched: true })
} catch (error) {
  failed = true
  report('failed', { phase, kind: error?.name ?? 'Error' })
} finally {
  if (vault && command) {
    try {
      const existing = await command('load', connectionId)
      if (existing.outcome !== 'missing') {
        await vault.clear()
        await assert.rejects(vault.load())
        const pending = await vault.pendingRevocationTokens()
        if (pending) {
          const store = new MemoryOAuthTokenStore(); await store.save(pending)
          await new PlatformAuthClient({ issuer, clientId, redirectUri: 'http://127.0.0.1:48174/callback', scopes: ['openid'], tokenStore: store, fetch: request }).revoke()
        }
        report('remote_revocation_confirmed', { connectionId })
        const beforeAck = await command('load', connectionId)
        assert.equal((await command('ack_revoke', connectionId, { revision: beforeAck.record.revision })).outcome, 'invalid_receipt')
        report('unsigned_revocation_receipt_denied', { connectionId })
        await vault.acknowledgeRevocation()
        const cleaned = await command('load', connectionId)
        assert.equal(cleaned.record.state, 'revoked'); assert.equal(cleaned.record.envelope, null)
        report('cloud_connection_revoked', { connectionId, ciphertextDestroyed: true })
      }
    } catch { failed = true; report('cloud_connection_cleanup_required', { connectionId, clientId }) }
  }
  if (bootstrap) { try { await bootstrap.revoke() } catch { failed = true; report('bootstrap_revoke_failed') } }
  if (loggedIn) {
    const result = await db.auth.signOut({ scope: 'local' })
    if (result.error) failed = true
    report('cloud_test_login_logout', { passed: !result.error })
  }
  if (clientId) report('operator_metadata_cleanup_required', { clientId, connectionId, loginId })
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.exit(failed ? 1 : 0)
}
