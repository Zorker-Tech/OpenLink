import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test,{after} from 'node:test'
import React,{act} from 'react'
import * as jsx from 'react/jsx-runtime'
import {JSDOM,VirtualConsole} from 'jsdom'
import ts from 'typescript'
import {CloudBrowserError,createCloudConnectionsBrowser} from '../../lib/platform-cloud-browser.ts'

const browserErrors=[],virtualConsole=new VirtualConsole()
virtualConsole.on('jsdomError',error=>browserErrors.push(error))
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://openlink.example/settings',virtualConsole})
const original=new Map()
for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true})){
  original.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value})
}
const oldFetch=globalThis.fetch
after(()=>{globalThis.fetch=oldFetch;dom.window.close();for(const [name,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name]}})
const {createRoot}=await import('react-dom/client')
function load(relative,modules){
  const code=ts.transpileModule(readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const exports={};new Function('require','exports','process',code)(name=>{if(!(name in modules))throw new Error('Unexpected import '+name);return modules[name]},exports,{env:{}});return exports
}
const common={'react':React,'react/jsx-runtime':jsx,'lucide-react':{Loader2:props=>React.createElement('span',props),Check:()=>null}}
const prefs=load('../../components/settings/preferences-form.tsx',{...common,'@/app/settings/actions':{},'@/components/ui/app-select':{}})
const {CloudConnectionsSettings}=load('../../components/settings/cloud-connections.tsx',{...common,
  '@/components/settings/preferences-form':prefs,'@/lib/platform-cloud-browser':{CloudBrowserError,createCloudConnectionsBrowser}})
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
async function mount(fetcher,loginEnabled=true){
  globalThis.fetch=fetcher
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
  await act(async()=>{root.render(React.createElement(CloudConnectionsSettings,{loginEnabled,locale:'zh-CN'}));await tick()})
  return{container,close:async()=>{await act(async()=>root.unmount());container.remove()}}
}
const find=(node,text)=>[...node.querySelectorAll('button')].find(button=>button.textContent===text)
const row={id:'00000000-0000-4000-8000-000000000001',issuer:'https://auth.hydite.com',subject:'synthetic-user',state:'active'}

test('stored authorization is not called verified before the identity response',async()=>{
  let finish
  const h=await mount(async url=>url==='/api/platform/connections'?Response.json({connections:[row]}):new Promise(resolve=>{finish=resolve}))
  try{
    assert.match(h.container.textContent,/尚未验证/);assert.doesNotMatch(h.container.textContent,/身份已验证/)
    await act(async()=>{finish(Response.json({connected:true,subject:row.subject}));await tick()})
    assert.match(h.container.textContent,/身份已验证/)
  }finally{await h.close()}
})
test('a failed list is unknown, not an empty connection or permission to connect',async()=>{
  const h=await mount(async()=>{throw new Error('private-server-token')})
  try{assert.match(h.container.textContent,/连接状态暂时不可用/);assert.doesNotMatch(h.container.textContent,/尚未连接|private-server-token/);assert.equal(find(h.container,'连接账号').disabled,true)}finally{await h.close()}
})
test('disconnect double-click produces one request and preserves pending-revocation state',async()=>{
  let state='active',deletes=0,finish
  const h=await mount(async(url,options)=>{
    if(options.method==='DELETE'){deletes++;return new Promise(resolve=>{finish=()=>{state='revoking';resolve(Response.json({revoked:false,revocationPending:true},{status:202}))}})}
    return url==='/api/platform/connections'?Response.json({connections:[{...row,state}]}):Response.json({connected:true,subject:row.subject})
  })
  try{
    await act(async()=>{find(h.container,'解除授权').click();find(h.container,'解除授权').click();await tick()})
    assert.equal(deletes,1)
    await act(async()=>{finish();await tick()})
    assert.match(h.container.textContent,/远端撤销待确认/);assert.doesNotMatch(h.container.textContent,/身份已验证/)
    assert.ok(find(h.container,'重试撤销'))
  }finally{await h.close()}
})
test('disabled login remains disabled even when no connection exists',async()=>{
  const h=await mount(async()=>Response.json({connections:[]}),false)
  try{assert.match(h.container.textContent,/尚未连接/);assert.match(h.container.textContent,/Cloud 登录尚未开放/);assert.equal(find(h.container,'连接账号').disabled,true)}finally{await h.close()}
})
test('an unmounted control cannot navigate after a delayed authorization response',async()=>{
  let finish,requests=0
  const h=await mount(async(_url,options)=>{
    if(options.method==='POST'){requests++;return new Promise(resolve=>{finish=resolve})}
    return Response.json({connections:[]})
  })
  await act(async()=>{find(h.container,'连接账号').click();await tick()})
  assert.equal(requests,1)
  await h.close()
  const errors=browserErrors.length
  await act(async()=>{finish(Response.json({authorizationUrl:'https://auth.hydite.com/oauth/authorize?state=fixture'}));await tick()})
  // JSDOM would report its unimplemented cross-origin navigation if assign ran.
  assert.equal(browserErrors.length,errors)
})
test('the actual settings page omits the Cloud control in Local mode',async()=>{
  for(const mode of ['local','cloud']){
    let renders=0
    const page=load('../../app/settings/page.tsx',{'react/jsx-runtime':jsx,
      '@/components/settings/preferences-form':{PreferencesForm:()=>null},
      '@/components/settings/cloud-connections':{CloudConnectionsSettings:props=>{renders++;assert.equal(props.loginEnabled,false);return null}},
      '@/lib/runtime-mode.server':{getRuntimeMode:()=>mode},
      '@/lib/user-preferences.server':{getUserPreferences:async()=>({locale:'zh-CN'})},
      '@/utils/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:'user'}}})}})},
      'next/navigation':{redirect:()=>{throw new Error('Unexpected redirect')}},
    })
    const {renderToStaticMarkup}=await import('react-dom/server')
    renderToStaticMarkup(await page.default())
    assert.equal(renders,mode==='cloud'?1:0)
  }
})
