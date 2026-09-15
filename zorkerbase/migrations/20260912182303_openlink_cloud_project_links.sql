-- References only: this does not transfer files or change native execution mode.
create table openlink.cloud_project_links (
  project_id uuid primary key references openlink.projects(id) on delete cascade,
  platform_project_ref uuid not null,
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table openlink.cloud_project_links enable row level security;

create function openlink_cloud_private.can_manage_project_link(p_project_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists (
    select 1 from openlink.projects p join openlink.workspaces w on w.id=p.workspace_id
    where p.id=p_project_id and (
      (w.scope_type='personal' and w.owner_id=(select auth.uid())) or
      (w.scope_type='organization' and openlink_private.has_organization_role(w.organization_id,array['owner','admin'],(select auth.uid())))
    )
  );
$$;
revoke all on function openlink_cloud_private.can_manage_project_link(uuid) from public,anon;
grant execute on function openlink_cloud_private.can_manage_project_link(uuid) to authenticated;

create policy cloud_project_link_read on openlink.cloud_project_links for select to authenticated
  using(exists(select 1 from openlink.projects p where p.id=project_id));
create policy cloud_project_link_insert on openlink.cloud_project_links for insert to authenticated
  with check(updated_by=(select auth.uid()) and openlink_cloud_private.can_manage_project_link(project_id));
create policy cloud_project_link_update on openlink.cloud_project_links for update to authenticated
  using(openlink_cloud_private.can_manage_project_link(project_id))
  with check(updated_by=(select auth.uid()) and openlink_cloud_private.can_manage_project_link(project_id));
create policy cloud_project_link_delete on openlink.cloud_project_links for delete to authenticated
  using(openlink_cloud_private.can_manage_project_link(project_id));
revoke all on openlink.cloud_project_links from public,anon,authenticated;
grant select,insert,update,delete on openlink.cloud_project_links to authenticated;

-- Preserve revision/audit/eligibility invariants for direct Data API writers too.
create function openlink_cloud_private.guard_project_link_write()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_project record;
begin
  if tg_op='UPDATE' and new.updated_by is null and old.updated_by is not null
    and to_jsonb(new)-'updated_by'=to_jsonb(old)-'updated_by' then
    return new; -- FK metadata cleanup; authenticated RLS cannot clear this field itself.
  end if;
  if auth.uid() is null then raise exception 'Project authentication required' using errcode='42501'; end if;
  select status into v_project from openlink.projects where id=new.project_id for share;
  if not found or v_project.status='archived' then
    raise exception 'Project is not eligible for Cloud linking' using errcode='42501';
  end if;
  if tg_op='INSERT' then new.revision:=1;
  elsif new.project_id<>old.project_id or new.revision<>old.revision+1 then
    raise exception 'Project link revision conflict' using errcode='40001';
  end if;
  new.updated_by:=auth.uid();new.updated_at:=clock_timestamp();
  return new;
end;
$$;
revoke all on function openlink_cloud_private.guard_project_link_write() from public,anon;
grant execute on function openlink_cloud_private.guard_project_link_write() to authenticated;
create trigger cloud_project_link_write_guard before insert or update on openlink.cloud_project_links
for each row execute function openlink_cloud_private.guard_project_link_write();

create function openlink.cloud_project_link_command(p_operation text,p_project_id uuid,p_platform_project_ref uuid default null,p_revision bigint default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_project record;
  v_link openlink.cloud_project_links%rowtype;
  v_manage boolean;
begin
  if auth.uid() is null then raise exception 'Project authentication required' using errcode='42501'; end if;
  -- Existing project RLS determines visibility; lock metadata while mutating the reference.
  if p_operation='get' then
    select id,status into v_project from openlink.projects where id=p_project_id;
  else
    select id,status into v_project from openlink.projects where id=p_project_id for share;
  end if;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  v_manage:=openlink_cloud_private.can_manage_project_link(p_project_id);
  if p_operation='get' then
    select * into v_link from openlink.cloud_project_links where project_id=p_project_id;
    return jsonb_build_object('outcome','loaded','project',to_jsonb(v_project),'link',case when v_link.project_id is null then null else to_jsonb(v_link) end,'can_manage',v_manage);
  end if;
  if not v_manage then return jsonb_build_object('outcome','forbidden'); end if;
  if p_revision is null or p_revision<0 then raise exception 'Project link revision required' using errcode='22023'; end if;
  if p_operation='set' then
    if v_project.status='archived' then return jsonb_build_object('outcome','ineligible'); end if;
    if p_platform_project_ref is null then raise exception 'Cloud project reference required' using errcode='22023'; end if;
    if p_revision=0 then
      insert into openlink.cloud_project_links(project_id,platform_project_ref,updated_by)
      values(p_project_id,p_platform_project_ref,auth.uid()) on conflict(project_id) do nothing returning * into v_link;
    else
      update openlink.cloud_project_links set platform_project_ref=p_platform_project_ref,revision=revision+1,updated_by=auth.uid(),updated_at=clock_timestamp()
        where project_id=p_project_id and revision=p_revision returning * into v_link;
    end if;
  elsif p_operation='remove' then
    delete from openlink.cloud_project_links where project_id=p_project_id and revision=p_revision returning * into v_link;
  else raise exception 'Unknown project link command' using errcode='22023';
  end if;
  if v_link.project_id is null then return jsonb_build_object('outcome','conflict'); end if;
  return jsonb_build_object('outcome',case when p_operation='remove' then 'removed' else 'saved' end,'link',to_jsonb(v_link));
end;
$$;
revoke all on function openlink.cloud_project_link_command(text,uuid,uuid,bigint) from public,anon;
grant execute on function openlink.cloud_project_link_command(text,uuid,uuid,bigint) to authenticated;
comment on table openlink.cloud_project_links is 'App-to-cloud references, not remote permission grants or execution migration. Every use must recheck the caller own cloud identity/project authority.';
notify pgrst,'reload schema';
