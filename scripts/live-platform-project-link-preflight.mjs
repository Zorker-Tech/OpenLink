import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parseEnv} from 'node:util'
import {randomUUID} from 'node:crypto'
import {createClient} from '@supabase/supabase-js'
import {createCloudProjectLinks} from '../lib/platform-cloud-project.ts'

const env=parseEnv(readFileSync(new URL('../.env.local',import.meta.url),'utf8'))
const url=env.OPENLINK_CLOUD_SUPABASE_URL||env.NEXT_PUBLIC_SUPABASE_URL
const key=env.OPENLINK_CLOUD_SUPABASE_PUBLISHABLE_KEY||env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
assert.equal(new URL(url).origin,'https://pool.hydite.com')
if(!key.startsWith('sb_publishable_'))assert.equal(JSON.parse(Buffer.from(key.split('.')[1],'base64url')).role,'anon')
const request=(url,init={})=>fetch(url,{...init,redirect:'manual',signal:init.signal??AbortSignal.timeout(20000)})
const client=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:request}})
const db=client(), report=(check,details={})=>console.log(JSON.stringify({check,...details}))
let loggedIn=false,failed=false
async function hidden(){
  if(process.stdin.isTTY)process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8');report('awaiting_hidden_credential_json')
  return new Promise((resolve,reject)=>{let text='';const receive=chunk=>{
    text+=chunk;if(text.length>4096){process.stdin.off('data',receive);reject(new Error('input bound'));return}
    if(/[\r\n]/.test(text)){process.stdin.off('data',receive);process.stdin.pause();try{resolve(JSON.parse(text.trim()))}catch{reject(new Error('input invalid'))}}
  };process.stdin.on('data',receive)})
}
try{
  const credentials=await hidden();assert.equal(credentials.email,'yikewang@info.hydite.com')
  const {data,error}=await db.auth.signInWithPassword(credentials);credentials.password=''
  assert.equal(error,null);assert.equal(data.user.id,'4d59a5c9-3489-49eb-927f-df592279ec7b');loggedIn=true
  const projects=await db.schema('openlink').from('projects').select('id,status');assert.equal(projects.error,null)
  report('visible_application_projects',{count:projects.data.length})
  let cloudCalls=0
  const service=createCloudProjectLinks({mode:'cloud',userId:data.user.id,
    command:async(operation,projectId,platformRef,revision)=>{
      const result=await db.schema('openlink').rpc('cloud_project_link_command',{p_operation:operation,p_project_id:projectId,p_platform_project_ref:platformRef??null,p_revision:revision??null})
      if(result.error)throw new Error('Project link RPC failed');return result.data
    },connection:async()=>{cloudCalls++;throw new Error('Missing project must not resolve cloud credentials')}})
  const absent=randomUUID()
  await assert.rejects(service.read(absent),error=>error.status===404)
  await assert.rejects(service.set(absent,randomUUID(),randomUUID(),0),error=>error.status===404)
  assert.equal(cloudCalls,0)
  const denied=await client().schema('openlink').rpc('cloud_project_link_command',{p_operation:'get',p_project_id:absent})
  assert.ok(denied.error)
  report('real_project_link_denials',{missingReadDenied:true,missingWriteDenied:true,anonymousDenied:true,cloudCalls:0,positiveMappingTested:false})
}catch(error){failed=true;report('failed',{kind:error?.name??'Error'})}
finally{
  if(loggedIn){const result=await db.auth.signOut({scope:'local'});failed=failed||!!result.error;report('test_login_logout',{passed:!result.error})}
  if(process.stdin.isTTY)process.stdin.setRawMode(false)
  process.exit(failed?1:0)
}
