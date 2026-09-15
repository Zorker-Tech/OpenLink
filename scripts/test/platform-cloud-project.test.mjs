import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import test from 'node:test'
import {createCloudProjectLinks} from '../../lib/platform-cloud-project.ts'

const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const owner=uid(1),viewer=uid(2),foreign=uid(3),personal=uid(11),organization=uid(12),remote=uid(13),cloud=uid(20)
if(!process.env.OPENLINK_PGLITE_MODULE)throw new Error('Set the pinned PGlite test module')
const {PGlite}=await import(pathToFileURL(process.env.OPENLINK_PGLITE_MODULE).href)
test('Cloud links enforce app RLS and independent cloud authority',async t=>{
  const db=new PGlite()
  try{
    await db.exec(`create role anon;create role authenticated;create schema auth;create schema openlink;create schema openlink_private;create schema openlink_cloud_private;
      create table auth.users(id uuid primary key);insert into auth.users values('${owner}'),('${viewer}'),('${foreign}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table openlink.workspaces(id uuid primary key,scope_type text,owner_id uuid,organization_id uuid);
      create table openlink.organization_members(organization_id uuid,user_id uuid,role text);
      create function openlink_private.has_organization_role(p_org uuid,p_roles text[],p_user uuid default auth.uid()) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from openlink.organization_members where organization_id=p_org and user_id=p_user and role=any(p_roles))$$;
      create table openlink.projects(id uuid primary key,workspace_id uuid references openlink.workspaces(id),status text,execution_mode text);
      insert into openlink.workspaces values('${uid(31)}','personal','${owner}',null),('${uid(32)}','organization',null,'${uid(33)}');
      insert into openlink.organization_members values('${uid(33)}','${owner}','admin'),('${uid(33)}','${viewer}','member');
      insert into openlink.projects values('${personal}','${uid(31)}','active','local'),('${organization}','${uid(32)}','active','local'),('${remote}','${uid(31)}','active','ssh');
      alter table openlink.projects enable row level security;
      create policy project_read on openlink.projects for select to authenticated using(exists(select 1 from openlink.workspaces w where w.id=workspace_id and (w.owner_id=auth.uid() or openlink_private.has_organization_role(w.organization_id,array['admin','member']))));
      create policy project_write on openlink.projects for update to authenticated using(exists(select 1 from openlink.workspaces w where w.id=workspace_id and (w.owner_id=auth.uid() or openlink_private.has_organization_role(w.organization_id,array['admin']))));
      grant usage on schema auth,openlink,openlink_private,openlink_cloud_private to authenticated;
      grant select,update on openlink.projects to authenticated;grant select on openlink.workspaces to authenticated;`)
    await db.exec(readFileSync(new URL('../../zorkerbase/migrations/20260912182303_openlink_cloud_project_links.sql',import.meta.url),'utf8'))
    const asUser=(actor,fn)=>db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);return fn(tx)})
    const command=actor=>async(operation,projectId,platformRef,revision)=>asUser(actor,async tx=>(await tx.query('select openlink.cloud_project_link_command($1,$2,$3,$4) result',[operation,projectId,platformRef??null,revision??null])).rows[0].result)
    let cloudCalls=0,accessible=true
    const connection=async()=>{cloudCalls++;return {state:'active',sdk:{listProjects:async()=>accessible?[{id:cloud,name:'Cloud',organizationId:uid(40)}]:[]}}}
    const service=actor=>createCloudProjectLinks({mode:'cloud',userId:actor,command:command(actor),connection})

    await t.test('owner creates a link; revision conflicts do not overwrite it',async()=>{
      const saved=await service(owner).set(personal,uid(50),cloud,0)
      assert.equal(saved.revision,1);assert.equal(saved.platform_project_ref,cloud)
      await assert.rejects(service(owner).set(personal,uid(50),cloud,0),error=>error.status===409)
      assert.equal((await service(owner).set(personal,uid(50),cloud,1)).revision,2)
    })
    await t.test('ordinary members can read but cannot configure organization links',async()=>{
      await service(owner).set(organization,uid(50),cloud,0)
      const read=await service(viewer).read(organization)
      assert.equal(read.link.platform_project_ref,cloud);assert.equal(read.can_manage,false)
      const before=cloudCalls
      await assert.rejects(service(viewer).set(organization,uid(50),cloud,1),error=>error.status===403)
      assert.equal(cloudCalls,before)
      const direct=await command(viewer)('set',organization,cloud,1)
      assert.ok(['missing','forbidden'].includes(direct.outcome))
    })
    await t.test('foreign app identity is denied and links do not change SSH execution',async()=>{
      const before=cloudCalls
      await assert.rejects(service(foreign).resolve(personal,uid(50)),error=>error.status===404)
      assert.equal(cloudCalls,before)
      await service(owner).set(remote,uid(50),cloud,0)
      assert.equal((await db.query('select execution_mode from openlink.projects where id=$1',[remote])).rows[0].execution_mode,'ssh')
      assert.throws(()=>createCloudProjectLinks({mode:'local',userId:owner,command:command(owner),connection}),/UNAVAILABLE/)
    })
    await t.test('cloud permissions are rechecked on every resolved use',async()=>{
      const resolved=await service(owner).resolve(personal,uid(50))
      assert.deepEqual(resolved.binding,{openlinkUserId:owner,openlinkProjectId:personal,platformProjectRef:cloud})
      accessible=false
      await assert.rejects(service(owner).resolve(personal,uid(50)),error=>error.status===403)
      await assert.rejects(service(owner).set(personal,uid(50),cloud,2),error=>error.status===403)
      assert.equal((await service(owner).read(personal)).link.revision,2)
      accessible=true
    })
    await t.test('direct data writes preserve revision, actor and archived restrictions',async()=>{
      await assert.rejects(asUser(owner,tx=>tx.query('update openlink.cloud_project_links set platform_project_ref=$1 where project_id=$2',[uid(99),personal])),/revision conflict/)
      await db.query("update openlink.projects set status='archived' where id=$1",[remote])
      await assert.rejects(asUser(owner,tx=>tx.query('update openlink.cloud_project_links set revision=revision+1 where project_id=$1',[remote])),/not eligible/)
      await asUser(owner,tx=>tx.query('update openlink.cloud_project_links set revision=revision+1,updated_by=$1 where project_id=$2',[foreign,personal]))
      const row=(await service(owner).read(personal)).link
      assert.equal(row.updated_by,owner);assert.equal(row.revision,3)
    })
    await t.test('unlink removes only metadata and anonymous calls are denied',async()=>{
      await service(owner).remove(personal,3)
      assert.equal((await service(owner).read(personal)).link,null)
      assert.equal((await db.query('select count(*)::int n from openlink.projects')).rows[0].n,3)
      assert.equal((await db.query("select has_function_privilege('anon','openlink.cloud_project_link_command(text,uuid,uuid,bigint)','execute') allowed")).rows[0].allowed,false)
    })
  }finally{await db.close()}
})
