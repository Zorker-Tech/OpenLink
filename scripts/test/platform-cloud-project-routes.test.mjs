import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import {CloudProjectLinkError} from '../../lib/platform-cloud-project.ts'

const code=ts.transpileModule(readFileSync(new URL('../../app/api/platform/projects/[projectId]/cloud/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
function fixture({failure=null}={}){
  const calls=[]
  class CloudConnectionError extends Error{constructor(status,message){super(message);this.status=status}}
  const service={read:async id=>({link:{project_id:id},can_manage:true}),resolve:async(id,connection)=>({link:{project_id:id},cloudProject:{id:'cloud'},sdk:{token:'private'}}),
    set:async(...args)=>{calls.push(args);return{revision:1}},remove:async(...args)=>calls.push(args)}
  const exports={}
  const modules={'@/lib/platform-cloud-project':{CloudProjectLinkError},'@/lib/platform-cloud-connection.server':{CloudConnectionError},
    '@/lib/platform-cloud-project.server':{cloudProjectLinksForRequest:async()=>{if(failure)throw failure==='auth'?new CloudConnectionError(401,'AUTHENTICATION_REQUIRED'):new Error('private-token');return service}}}
  new Function('require','exports','process',code)(name=>modules[name],exports,{env:{OPENLINK_APP_URL:'https://openlink.example'}})
  return{exports,calls}
}
const context={params:Promise.resolve({projectId:'project-from-route'})}
const valid={connectionId:'connection',platformProjectRef:'cloud',revision:0,userId:'attacker',projectId:'attacker'}
test('mapping route does not serialize clients or claim execution migration',async()=>{
  const f=fixture();const response=await f.exports.GET(new Request('https://openlink.example/api?connectionId=connection'),context)
  const body=await response.json();assert.equal(body.executionMigrated,false);assert.ok(!JSON.stringify(body).includes('private'))
  assert.equal(response.headers.get('cache-control'),'private, no-store')
})
test('mapping mutation ignores caller identity overrides and uses the route project',async()=>{
  const f=fixture();const response=await f.exports.PUT(new Request('https://openlink.example/api',{method:'PUT',headers:{origin:'https://openlink.example'},body:JSON.stringify(valid)}),context)
  assert.equal(response.status,200);assert.deepEqual(f.calls[0],['project-from-route','connection','cloud',0])
})
test('foreign origin, unauthenticated callers and malformed bodies cannot mutate',async()=>{
  for(const [options,origin,body,status] of [[{},'https://attacker.example','{}',403],[{failure:'auth'},'https://openlink.example','{}',401],[{},'https://openlink.example','{',400]]){
    const f=fixture(options);const response=await f.exports.PUT(new Request('https://openlink.example/api',{method:'PUT',headers:{origin},body}),context)
    assert.equal(response.status,status);assert.equal(f.calls.length,0)
  }
})
test('oversized and aborted request streams are cancelled without mutation',async()=>{
  for(const aborted of [false,true]){
    let cancelled=false;const controller=new AbortController()
    const stream=new ReadableStream({start(c){if(!aborted)c.enqueue(new Uint8Array(3000))},cancel(){cancelled=true}})
    const request=new Request('https://openlink.example/api',{method:'PUT',headers:{origin:'https://openlink.example'},body:stream,duplex:'half',signal:controller.signal})
    if(aborted)controller.abort()
    const f=fixture();assert.equal((await f.exports.PUT(request,context)).status,aborted?408:413)
    assert.equal(f.calls.length,0);assert.equal(cancelled,true)
  }
})
test('dependency errors stay redacted and unlink does not invoke cloud deletion',async()=>{
  const failed=await fixture({failure:'server'}).exports.GET(new Request('https://openlink.example/api'),context)
  assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('private-token'))
  const f=fixture();assert.equal((await f.exports.DELETE(new Request('https://openlink.example/api?revision=2',{method:'DELETE',headers:{origin:'https://openlink.example'}}),context)).status,204)
  assert.deepEqual(f.calls,[['project-from-route',2]])
})
