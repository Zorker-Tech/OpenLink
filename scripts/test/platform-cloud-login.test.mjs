import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {randomBytes,randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import test from 'node:test'
import {beginCloudLogin,finishCloudLogin,parseCloudLoginCallback,cloudLoginCookie} from '../../lib/platform-cloud-login.ts'
import {createCloudLoginCipher,createCloudCredentialCipher} from '../../lib/platform-cloud-crypto.ts'

const user='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002'
const modulePath=process.env.OPENLINK_PGLITE_MODULE
if(!modulePath) throw new Error('Set the test-only PGlite module path')
const {PGlite}=await import(pathToFileURL(modulePath).href)

test('Cloud login uses one-use encrypted database PKCE transactions',async t=>{
  const db=new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;create schema openlink;create schema openlink_cloud_private;
      create table auth.users(id uuid primary key);insert into auth.users values('${user}'),('${other}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,openlink,openlink_cloud_private to authenticated;`)
    await db.exec(readFileSync(new URL('../../zorkerbase/migrations/20260912174704_openlink_cloud_oauth_login_transactions.sql',import.meta.url),'utf8'))
    const commandFor=actor=>async(operation,id,payload)=>db.transaction(async tx=>{
      await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
      return(await tx.query('select openlink.cloud_oauth_login_command($1,$2,$3::jsonb) result',[operation,id,JSON.stringify(payload)])).rows[0].result
    })
    const key=randomBytes(32),ring=new Map([['k1',key]]),cipher=createCloudLoginCipher(ring,'k1')
    const calls=[]
    const context={userId:user,clientId:'openlink-test',redirectUri:'https://openlink.example/auth/platform/callback',cipher,command:commandFor(user),
      fetch:async(url,options)=>{
        calls.push({url:String(url),options})
        if(String(url).includes('.well-known'))return Response.json({issuer:'https://auth.hydite.com',authorization_endpoint:'https://auth.hydite.com/authorize',token_endpoint:'https://auth.hydite.com/token',userinfo_endpoint:'https://auth.hydite.com/userinfo',revocation_endpoint:'https://auth.hydite.com/revoke',code_challenge_methods_supported:['S256']})
        if(String(url).endsWith('/userinfo'))return Response.json({sub:'verified-cloud-user'})
        if(String(url).endsWith('/revoke'))return new Response(null,{status:200})
        return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:60,scope:'openid profile email computer:read computer:write'})
      }}
    const callback=(pending,extra='code=fixture-code')=>new Request('https://openlink.example/auth/platform/callback?state='+new URL(pending.authorizationUrl).searchParams.get('state')+'&'+extra,{headers:{cookie:cloudLoginCookie+'='+pending.cookieValue}})
    await t.test('PKCE verifier is encrypted, replay is refused and identities stay distinct',async()=>{
      const pending=await beginCloudLogin(context)
      const row=(await db.query('select * from openlink_cloud_private.login_transactions')).rows[0]
      assert.ok(row.envelope.ciphertext)
      assert.ok(!JSON.stringify(row).includes('codeVerifier'))
      const parsed=parseCloudLoginCallback(callback(pending));let persisted=0
      const result=await finishCloudLogin(context,parsed,async input=>{
        persisted++;assert.equal(input.subject,'verified-cloud-user');assert.notEqual(input.subject,user);assert.equal(input.tokens.accessToken,'synthetic-access')
      })
      assert.equal(result.connected,true);assert.equal(persisted,1)
      assert.equal((await db.query('select envelope from openlink_cloud_private.login_transactions where id=$1',[parsed.loginId])).rows[0].envelope,null)
      const count=calls.length
      await assert.rejects(finishCloudLogin(context,parsed,async()=>{}),/CONSUMED/)
      assert.equal(calls.length,count)
    })
    await t.test('wrong browser, duplicated state and foreign user cannot consume a login',async()=>{
      const pending=await beginCloudLogin(context),request=callback(pending),parsed=parseCloudLoginCallback(request)
      assert.throws(()=>parseCloudLoginCallback(new Request(request.url)),/STATE/)
      assert.throws(()=>parseCloudLoginCallback(new Request(request.url+'&state=other',{headers:request.headers})),/STATE/)
      assert.throws(()=>parseCloudLoginCallback(new Request(request.url,{headers:{cookie:cloudLoginCookie+'='+pending.cookieValue+'; '+cloudLoginCookie+'='+pending.cookieValue}})),/STATE/)
      const count=calls.length
      await assert.rejects(finishCloudLogin({...context,userId:other,command:commandFor(other)},parsed,async()=>{}),/CONSUMED/)
      assert.equal(calls.length,count)
      assert.equal((await finishCloudLogin(context,parsed,async()=>{})).connected,true)
    })
    await t.test('cancel and expired transactions never exchange credentials',async()=>{
      const pending=await beginCloudLogin(context),count=calls.length
      assert.deepEqual(await finishCloudLogin(context,parseCloudLoginCallback(callback(pending,'error=access_denied')),async()=>{throw new Error('must not persist')}),{connected:false})
      assert.equal(calls.length,count)
      const expired=await beginCloudLogin(context),parsed=parseCloudLoginCallback(callback(expired))
      await db.query("update openlink_cloud_private.login_transactions set expires_at=now()-interval '1 second' where id=$1",[parsed.loginId])
      await assert.rejects(finishCloudLogin(context,parsed,async()=>{}),/EXPIRED/)
    })
    await t.test('envelopes cannot move between owners, callbacks or token-store purposes',async()=>{
      const record={id:randomUUID(),user_id:user,connection_id:randomUUID(),client_id:'test',redirect_uri:context.redirectUri}
      const encrypted=cipher.seal({state:'a'.repeat(43),codeVerifier:'b'.repeat(43)},record)
      for(const patch of [{user_id:other},{connection_id:randomUUID()},{redirect_uri:'https://attacker.example'},{client_id:'other'}])
        assert.throws(()=>cipher.open(encrypted,{...record,...patch}),/authenticated/)
      assert.throws(()=>createCloudCredentialCipher(ring,'k1').open(encrypted,{id:record.connection_id,user_id:user,issuer:'https://auth.hydite.com',subject:'subject',client_id:'test',revision:1}),/authenticated/)
    })
    await t.test('failed persistence revokes the new grant rather than claiming success',async()=>{
      const pending=await beginCloudLogin(context)
      await assert.rejects(finishCloudLogin(context,parseCloudLoginCallback(callback(pending)),async()=>{throw new Error('private-storage-error')}),/CLOUD_LOGIN_FAILED/)
      assert.ok(calls.some(call=>call.url.endsWith('/revoke')))
    })
    await t.test('start budget counts consumed transactions and anonymous access stays denied',async()=>{
      for(let i=0;i<8;i++) { try {await beginCloudLogin(context)}catch(error){assert.equal(error.status,429);break} }
      await assert.rejects(beginCloudLogin(context),error=>error.status===429)
      assert.equal((await db.query("select has_function_privilege('anon','openlink.cloud_oauth_login_command(text,uuid,jsonb)','execute') allowed")).rows[0].allowed,false)
      assert.equal((await db.query("select prosecdef from pg_proc where oid='openlink.cloud_oauth_login_command(text,uuid,jsonb)'::regprocedure")).rows[0].prosecdef,false)
    })
  } finally {await db.close()}
})
