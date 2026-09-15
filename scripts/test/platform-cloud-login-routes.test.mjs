import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import {CloudLoginError,cloudLoginCookie,parseCloudLoginCallback} from '../../lib/platform-cloud-login.ts'

const {NextResponse}=createRequire(import.meta.url)('next/server')
const id='00000000-0000-4000-8000-000000000003',state='s'.repeat(43)
function fixture({error=null}={}) {
  let starts=0,callbacks=0
  class CloudConnectionError extends Error {constructor(status,code){super(code);this.status=status}}
  const modules={
    'next/server':{NextResponse},
    '@/lib/platform-cloud-login':{CloudLoginError,cloudLoginCookie,parseCloudLoginCallback},
    '@/lib/platform-cloud-connection.server':{CloudConnectionError},
    '@/lib/platform-cloud-login.server':{
      startCloudConnectionLogin:async()=>{starts++;if(error)throw error;return{authorizationUrl:'https://auth.hydite.com/authorize?state='+state,cookieValue:id+'.'+state,codeVerifier:'private-verifier'}},
      completeCloudConnectionLogin:async()=>{callbacks++;if(error)throw error;return{destination:'https://openlink.example/settings?cloud=connected'}},
    },
  }
  function load(path) {
    const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    const exports={};new Function('require','exports',code)(name=>modules[name],exports);return exports
  }
  return {start:load('../../app/api/platform/connections/start/route.ts'),callback:load('../../app/auth/platform/callback/route.ts'),counts:()=>({starts,callbacks})}
}
const callbackRequest=(cookie=true)=>new Request('https://openlink.example/auth/platform/callback?code=private-code&state='+state+'&next=https://attacker.example',{
  headers:cookie?{cookie:cloudLoginCookie+'='+id+'.'+state}:{},
})

test('start returns only the authorization URL and a secure host-only state cookie',async()=>{
  const f=fixture();const response=await f.start.POST(new Request('https://openlink.example/api/platform/connections/start',{method:'POST'}))
  const body=await response.json();assert.deepEqual(Object.keys(body),['authorizationUrl'])
  assert.ok(!JSON.stringify(body).includes('private-verifier'))
  const cookie=response.headers.get('set-cookie')
  for(const pattern of [/__Host-openlink-cloud-oauth=/,/Path=\//,/Secure/,/HttpOnly/,/SameSite=lax/,/Max-Age=300/]) assert.match(cookie,pattern)
  assert.ok(!cookie.includes('Domain='))
  assert.equal(response.headers.get('cache-control'),'private, no-store')
  assert.equal(response.headers.get('referrer-policy'),'no-referrer')
})
test('callback without matching browser state performs no completion work',async()=>{
  const f=fixture();const response=await f.callback.GET(callbackRequest(false))
  assert.equal(response.status,400);assert.equal(f.counts().callbacks,0)
  assert.equal(response.headers.get('set-cookie'),null)
})
test('valid callback clears state and never echoes the authorization code',async()=>{
  const f=fixture();const response=await f.callback.GET(callbackRequest())
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'https://openlink.example/settings?cloud=connected')
  assert.match(response.headers.get('set-cookie'),/Max-Age=0/)
  assert.ok(![...response.headers].flat().join(' ').includes('private-code'))
  assert.equal(response.headers.get('referrer-policy'),'no-referrer')
})
test('callback errors are redacted and never redirect as connected',async()=>{
  const f=fixture({error:new Error('private-credential-material')})
  const response=await f.callback.GET(callbackRequest())
  assert.equal(response.status,503);assert.equal(response.headers.get('location'),null)
  assert.ok(!(await response.text()).includes('private-credential-material'))
  assert.match(response.headers.get('set-cookie'),/Max-Age=0/)
})
