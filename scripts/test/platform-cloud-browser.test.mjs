import assert from 'node:assert/strict'
import test from 'node:test'
import {createCloudConnectionsBrowser} from '../../lib/platform-cloud-browser.ts'

const id='00000000-0000-4000-8000-000000000001'
const connection={id,issuer:'https://auth.hydite.com',subject:'subject',state:'active'}
test('browser uses same-origin BFF cookies and projects only safe metadata',async()=>{
  const calls=[]
  const api=createCloudConnectionsBrowser(async(url,options)=>{calls.push({url,options});return Response.json({connections:[{...connection,envelope:{private:'secret'}}]})})
  assert.deepEqual(await api.list(),[connection])
  assert.equal(calls[0].url,'/api/platform/connections')
  assert.equal(calls[0].options.credentials,'same-origin')
  assert.equal(calls[0].options.redirect,'error')
  assert.equal(calls[0].options.headers.authorization,undefined)
})
test('verified identity must match the listed subject',async()=>{
  const api=createCloudConnectionsBrowser(async()=>Response.json({connected:true,subject:'other'}))
  await assert.rejects(api.verify(connection),error=>error.code==='INVALID_RESPONSE')
  const inactive=createCloudConnectionsBrowser(async()=>Response.json({connected:false,state:'revoking'}))
  assert.deepEqual(await inactive.verify(connection),{connected:false,state:'revoking'})
})
test('authorization navigation cannot leave the trusted issuer',async()=>{
  for(const authorizationUrl of ['https://attacker.example/authorize','https://user:password@auth.hydite.com/authorize','javascript:alert(1)']){
    await assert.rejects(createCloudConnectionsBrowser(async()=>Response.json({authorizationUrl})).start())
  }
  assert.equal(await createCloudConnectionsBrowser(async()=>Response.json({authorizationUrl:'https://auth.hydite.com/oauth/authorize?state=test'})).start(),'https://auth.hydite.com/oauth/authorize?state=test')
})
test('pending revoke is not success and mutating requests are not retried',async()=>{
  let calls=0
  const api=createCloudConnectionsBrowser(async()=>{calls++;return Response.json({revoked:false,revocationPending:true},{status:202})})
  assert.equal(await api.disconnect(id),'pending');assert.equal(calls,1)
  const failed=createCloudConnectionsBrowser(async()=>{calls++;return Response.json({error:'private-token'},{status:503})})
  await assert.rejects(failed.disconnect(id),error=>error.code==='SERVICE_UNAVAILABLE'&&!error.message.includes('private-token'))
  assert.equal(calls,2)
})
test('malformed, oversized and cancelled requests fail without credential leakage',async()=>{
  const controller=new AbortController();controller.abort();let called=false
  const cancelled=createCloudConnectionsBrowser(async()=>{called=true;return Response.json({connections:[]})})
  await assert.rejects(cancelled.list(controller.signal),error=>error.code==='CANCELLED');assert.equal(called,false)
  let stopped=false
  const oversized=createCloudConnectionsBrowser(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537))},cancel(){stopped=true}})))
  await assert.rejects(oversized.list(),error=>error.code==='INVALID_RESPONSE');assert.equal(stopped,true)
  await assert.rejects(createCloudConnectionsBrowser(async()=>Response.json({connections:[{...connection,state:'unknown'}]})).list(),error=>error.code==='INVALID_RESPONSE')
})
