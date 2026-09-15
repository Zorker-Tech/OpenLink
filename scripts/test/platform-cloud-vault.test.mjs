import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { CloudOAuthVault, cloudConnectionCommand } from '../../lib/platform-cloud-vault.ts'
import { createCloudCredentialCipher, createCloudRevocationSigner } from '../../lib/platform-cloud-crypto.ts'
import { PlatformAuthClient } from '@vtslx/platform-sdk/auth'

const modulePath = process.env.OPENLINK_PGLITE_MODULE
if (!modulePath) throw new Error('Set OPENLINK_PGLITE_MODULE to the pinned test-only PGlite module')
const { PGlite } = await import(pathToFileURL(modulePath).href)
const user = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const id = '00000000-0000-4000-8000-000000000003'
const old = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', tokenType: 'Bearer', scope: ['openid'], expiresAt: Date.now() - 1000 }

test('database-backed Cloud vault fences rotation, identity and disconnect', async t => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create schema openlink;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,openlink to authenticated;
      insert into auth.users values ('${user}'),('${other}');`)
    await db.exec(readFileSync(new URL('../../zorkerbase/migrations/20260912164449_openlink_cloud_oauth_connections.sql', import.meta.url), 'utf8'))
    // PGlite does not ship pgcrypto. This primitive stub matches exact Node HMAC
    // vectors; production pgcrypto parity and live receipt acceptance are separate checks.
    await db.exec(`create schema extensions;
      create table extensions.unit_hmac_vectors(message bytea,secret bytea,algorithm text,result bytea,primary key(message,secret,algorithm));
      create function extensions.hmac(p_message bytea,p_secret bytea,p_algorithm text) returns bytea language sql stable as $$
        select result from extensions.unit_hmac_vectors where message=p_message and secret=p_secret and algorithm=p_algorithm $$;`)
    await db.exec(readFileSync(new URL('../../zorkerbase/migrations/20260912171037_openlink_cloud_oauth_revocation_receipts.sql', import.meta.url), 'utf8'))
    const commandFor = actor => async (operation, connectionId, payload = {}) => db.transaction(async tx => {
      await tx.exec('set local role authenticated')
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [actor])
      return (await tx.query('select openlink.cloud_oauth_connection_command($1,$2,$3::jsonb) result', [operation, connectionId, JSON.stringify(payload)])).rows[0].result
    })
    const command = commandFor(user)
    const cipher = createCloudCredentialCipher(new Map([['key-1', randomBytes(32)]]), 'key-1')
    const signingKey = randomBytes(32)
    await db.query("insert into openlink_cloud_private.revocation_keys(key_id,secret) values('receipt-1',$1)", [signingKey])
    const signer = createCloudRevocationSigner('receipt-1', signingKey)
    const signRevocation = async record => {
      const receipt = signer(record)
      const message = Buffer.from(['openlink/cloud-revocation/v1','receipt-1',record.user_id,record.id,String(record.revision)].join('\n'))
      await db.query("insert into extensions.unit_hmac_vectors values($1,$2,'sha256',$3) on conflict(message,secret,algorithm) do update set result=excluded.result", [message, signingKey, Buffer.from(receipt.signature, 'hex')])
      return receipt
    }
    const options = { mode: 'cloud', userId: user, connectionId: id, subject: 'hydite-subject', clientId: 'openlink-cloud', command, cipher, signRevocation, wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))) }
    const vault = new CloudOAuthVault(options)

    await t.test('stores no plaintext and denies table access and other users', async () => {
      await vault.create(old)
      assert.deepEqual(await vault.load(), old)
      const rows = (await db.query('select * from openlink_cloud_private.oauth_connections')).rows
      assert.ok(!JSON.stringify(rows).includes(old.refreshToken))
      assert.equal((await commandFor(other)('load', id)).outcome, 'missing')
      assert.equal((await commandFor(other)('claim', id, { revision: 1 })).outcome, 'missing')
      const listed = await command('list', null)
      assert.equal(listed.connections.length, 1)
      assert.ok(!JSON.stringify(listed).includes('ciphertext'))
      assert.equal((await commandFor(other)('list', null)).connections.length, 0)
      await assert.rejects(db.transaction(async tx => {
        await tx.exec('set local role authenticated')
        return tx.query('select * from openlink_cloud_private.oauth_connections')
      }), /permission denied/)
      const flags = (await db.query(`select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='openlink' and p.proname='cloud_oauth_connection_command'`)).rows
      assert.equal(flags[0].prosecdef, false)
      assert.equal((await db.query("select has_function_privilege('anon','openlink.cloud_oauth_connection_command(text,uuid,jsonb)','execute') allowed")).rows[0].allowed, false)
    })

    await t.test('binds encryption to owner, connection, subject, client and revision', async () => {
      const record = (await command('load', id)).record
      for (const patch of [{ user_id: other }, { id: other }, { subject: 'other' }, { client_id: 'other' }, { revision: 2 }])
        assert.throws(() => cipher.open(record.envelope, { ...record, ...patch }), /could not be authenticated/)
      const corrupt = { ...record.envelope, tag: randomBytes(16).toString('base64') }
      assert.throws(() => cipher.open(corrupt, record), /could not be authenticated/)
    })

    await t.test('one lease wins and stale or missing leases cannot save', async () => {
      await assert.rejects(vault.save(old), /active refresh lease/)
      const first = await command('claim', id, { revision: 1 })
      assert.equal(first.outcome, 'claimed')
      assert.equal((await command('claim', id, { revision: 1 })).outcome, 'busy')
      assert.equal((await command('commit', id, { revision: 1, lease: other, envelope: first.record.envelope })).outcome, 'conflict')
      assert.equal((await command('release', id, { revision: 1, lease: first.lease })).outcome, 'released')
    })

    await t.test('two host instances share the rotated result without replay', async () => {
      const a = new CloudOAuthVault(options), b = new CloudOAuthVault(options)
      let exchanges = 0
      const fetcher = async url => {
        if (String(url).includes('.well-known')) return Response.json({ issuer: 'https://auth.hydite.com',
          authorization_endpoint: 'https://auth.hydite.com/authorize', token_endpoint: 'https://auth.hydite.com/token',
          code_challenge_methods_supported: ['S256'] })
        exchanges++
        await new Promise(resolve => setTimeout(resolve, 10))
        return Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', scope: 'openid', expires_in: 60 })
      }
      const auth = store => new PlatformAuthClient({ issuer: 'https://auth.hydite.com', clientId: options.clientId,
        redirectUri: 'https://openlink.example/callback', scopes: ['openid'], tokenStore: store, refreshCoordinator: store, fetch: fetcher })
      const results = await Promise.all([auth(a).getAccessToken(), auth(b).getAccessToken()])
      assert.equal(exchanges, 1)
      assert.deepEqual(results, ['synthetic-new-access', 'synthetic-new-access'])
      assert.equal((await command('load', id)).record.revision, 2)
    })

    await t.test('disconnect fences an in-flight save and retains cleanup credentials', async () => {
      await assert.rejects(vault.runExclusive(async () => {
        await new CloudOAuthVault(options).clear()
        await vault.save({ ...old, expiresAt: Date.now() + 60000 })
        return old
      }), /uncertain/)
      const record = (await command('load', id)).record
      assert.equal(record.state, 'revoking')
      assert.ok(record.envelope)
      assert.equal((await command('ack_revoke', id, { revision: record.revision })).outcome, 'invalid_receipt')
      assert.equal((await command('ack_revoke', id, { revision: record.revision, receipt: { key_id: 'receipt-1', signature: '00'.repeat(32) } })).outcome, 'invalid_receipt')
      await assert.rejects(db.transaction(async tx => {
        await tx.exec('set local role authenticated')
        return tx.query("select openlink_cloud_private.connection_command('ack_revoke',$1,$2::jsonb)", [id, JSON.stringify({revision: record.revision})])
      }), /permission denied/)
      assert.equal(cipher.open(record.envelope, record).refreshToken, 'synthetic-new-refresh')
      await assert.rejects(vault.load(), /reauthentication|revocation/)
      await vault.clear()
      await vault.acknowledgeRevocation()
      const cleared = (await command('load', id)).record
      assert.equal(cleared.state, 'revoked')
      assert.equal(cleared.envelope, null)
    })

    await t.test('an expired lease becomes uncertain instead of being stolen', async () => {
      const secondId = '00000000-0000-4000-8000-000000000004'
      const nextVault = new CloudOAuthVault({ ...options, connectionId: secondId })
      await nextVault.create(old)
      await command('claim', secondId, { revision: 1 })
      await db.query("update openlink_cloud_private.oauth_connections set lease_until=now()-interval '1 second' where id=$1", [secondId])
      assert.equal((await command('claim', secondId, { revision: 1 })).outcome, 'reauth_required')
      assert.equal((await command('load', secondId)).record.state, 'reauth_required')
      let called = false
      await assert.rejects(nextVault.runExclusive(async () => { called = true; return old }), /reauthentication/)
      assert.equal(called, false)
    })

    await t.test('RPC errors are redacted and Local never calls the database', async () => {
      const rpc = cloudConnectionCommand({ schema: () => ({ rpc: async () => ({ data: null, error: { message: old.refreshToken } }) }) })
      await assert.rejects(rpc('load', id), error => error.message === 'Cloud credential storage request failed')
      assert.throws(() => new CloudOAuthVault({ ...options, mode: 'local' }), /Local mode/)
    })
  } finally { await db.close() }
})
