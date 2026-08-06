create schema if not exists openlink_private;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'openlink' and t.typname = 'organization_role'
  ) then
    create type openlink.organization_role as enum ('owner', 'admin', 'member');
  end if;
end
$$;

alter table openlink.profiles
  add column if not exists organization_onboarding_completed boolean;

update openlink.profiles
set organization_onboarding_completed = true
where organization_onboarding_completed is null;

alter table openlink.profiles
  alter column organization_onboarding_completed set default false,
  alter column organization_onboarding_completed set not null;

create table if not exists openlink.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  join_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_name_length check (char_length(name) between 1 and 80),
  constraint organizations_slug_length check (char_length(slug) between 1 and 80),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint organizations_join_code_length check (char_length(join_code) between 6 and 32)
);

create table if not exists openlink.organization_members (
  organization_id uuid not null references openlink.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role openlink.organization_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index if not exists organization_members_user_id_idx
  on openlink.organization_members(user_id);

alter table openlink.workspaces
  add column if not exists scope_type text not null default 'personal',
  add column if not exists organization_id uuid references openlink.organizations(id) on delete cascade;

alter table openlink.workspaces alter column owner_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspaces_scope_type_check'
      and conrelid = 'openlink.workspaces'::regclass
  ) then
    alter table openlink.workspaces
      add constraint workspaces_scope_type_check
      check (scope_type in ('personal', 'organization'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'workspaces_scope_owner_check'
      and conrelid = 'openlink.workspaces'::regclass
  ) then
    alter table openlink.workspaces
      add constraint workspaces_scope_owner_check
      check (
        (scope_type = 'personal' and owner_id is not null and organization_id is null)
        or
        (scope_type = 'organization' and owner_id is null and organization_id is not null)
      );
  end if;
end
$$;

create unique index if not exists workspaces_organization_id_unique_idx
  on openlink.workspaces(organization_id)
  where organization_id is not null;

create or replace function openlink_private.is_organization_member(
  p_organization_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from openlink.organization_members
    where organization_id = p_organization_id
      and user_id = p_user_id
  );
$$;

create or replace function openlink_private.has_organization_role(
  p_organization_id uuid,
  p_roles text[],
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from openlink.organization_members
    where organization_id = p_organization_id
      and user_id = p_user_id
      and role::text = any(p_roles)
  );
$$;

create or replace function openlink_private.is_organization_creator(
  p_organization_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from openlink.organizations
    where id = p_organization_id
      and created_by = p_user_id
  );
$$;

alter table openlink.organizations enable row level security;
alter table openlink.organization_members enable row level security;

drop policy if exists "organizations_select_member" on openlink.organizations;
create policy "organizations_select_member"
  on openlink.organizations
  for select
  to authenticated
  using (openlink_private.is_organization_member(id));

drop policy if exists "organizations_insert_creator" on openlink.organizations;
create policy "organizations_insert_creator"
  on openlink.organizations
  for insert
  to authenticated
  with check ((select auth.uid()) = created_by);

drop policy if exists "organizations_update_admin" on openlink.organizations;
create policy "organizations_update_admin"
  on openlink.organizations
  for update
  to authenticated
  using (openlink_private.has_organization_role(id, array['owner', 'admin']))
  with check (openlink_private.has_organization_role(id, array['owner', 'admin']));

drop policy if exists "organizations_delete_owner" on openlink.organizations;
create policy "organizations_delete_owner"
  on openlink.organizations
  for delete
  to authenticated
  using (openlink_private.has_organization_role(id, array['owner']));

drop policy if exists "organization_members_select_peer" on openlink.organization_members;
create policy "organization_members_select_peer"
  on openlink.organization_members
  for select
  to authenticated
  using (openlink_private.is_organization_member(organization_id));

drop policy if exists "organization_members_insert_initial_owner" on openlink.organization_members;
create policy "organization_members_insert_initial_owner"
  on openlink.organization_members
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and role = 'owner'
    and openlink_private.is_organization_creator(organization_id)
  );

drop policy if exists "workspaces_select_own" on openlink.workspaces;
drop policy if exists "workspaces_insert_own" on openlink.workspaces;
drop policy if exists "workspaces_update_own" on openlink.workspaces;
drop policy if exists "workspaces_delete_own" on openlink.workspaces;

create policy "workspaces_select_accessible"
  on openlink.workspaces
  for select
  to authenticated
  using (
    (scope_type = 'personal' and owner_id = (select auth.uid()))
    or
    (scope_type = 'organization' and openlink_private.is_organization_member(organization_id))
  );

create policy "workspaces_insert_governed"
  on openlink.workspaces
  for insert
  to authenticated
  with check (
    (scope_type = 'personal' and owner_id = (select auth.uid()) and organization_id is null)
    or
    (
      scope_type = 'organization'
      and owner_id is null
      and openlink_private.has_organization_role(organization_id, array['owner', 'admin'])
    )
  );

create policy "workspaces_update_governed"
  on openlink.workspaces
  for update
  to authenticated
  using (
    (scope_type = 'personal' and owner_id = (select auth.uid()))
    or
    (scope_type = 'organization' and openlink_private.has_organization_role(organization_id, array['owner', 'admin']))
  )
  with check (
    (scope_type = 'personal' and owner_id = (select auth.uid()) and organization_id is null)
    or
    (
      scope_type = 'organization'
      and owner_id is null
      and openlink_private.has_organization_role(organization_id, array['owner', 'admin'])
    )
  );

create policy "workspaces_delete_governed"
  on openlink.workspaces
  for delete
  to authenticated
  using (
    (scope_type = 'personal' and owner_id = (select auth.uid()))
    or
    (scope_type = 'organization' and openlink_private.has_organization_role(organization_id, array['owner', 'admin']))
  );

create or replace function openlink.create_organization(
  p_name text,
  p_slug text
)
returns table (
  organization_id uuid,
  organization_name text,
  organization_slug text,
  workspace_id uuid,
  workspace_slug text,
  member_role text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := trim(p_name);
  v_slug text := lower(trim(p_slug));
  v_organization_id uuid := gen_random_uuid();
  v_workspace openlink.workspaces%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'INVALID_ORGANIZATION_NAME';
  end if;

  if char_length(v_slug) < 1 or char_length(v_slug) > 80
     or v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'INVALID_ORGANIZATION_SLUG';
  end if;

  insert into openlink.organizations (id, name, slug, created_by)
  values (v_organization_id, v_name, v_slug, v_user_id);

  insert into openlink.organization_members (organization_id, user_id, role)
  values (v_organization_id, v_user_id, 'owner');

  insert into openlink.workspaces (owner_id, organization_id, scope_type, name, slug)
  values (null, v_organization_id, 'organization', v_name, v_slug)
  returning * into v_workspace;

  update openlink.profiles
  set organization_onboarding_completed = true,
      updated_at = now()
  where user_id = v_user_id;

  return query
  select v_organization_id, v_name, v_slug,
         v_workspace.id, v_workspace.slug, 'owner'::text;
end;
$$;

create or replace function openlink_private.join_organization_by_code(p_code text)
returns table (
  organization_id uuid,
  organization_name text,
  organization_slug text,
  workspace_id uuid,
  workspace_slug text,
  member_role text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := upper(trim(p_code));
  v_organization openlink.organizations%rowtype;
  v_workspace openlink.workspaces%rowtype;
  v_member_role openlink.organization_role;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_organization
  from openlink.organizations
  where join_code = v_code;

  if v_organization.id is null then
    raise exception 'INVALID_JOIN_CODE';
  end if;

  insert into openlink.organization_members (organization_id, user_id, role)
  values (v_organization.id, v_user_id, 'member')
  on conflict on constraint organization_members_pkey do nothing;

  select role into v_member_role
  from openlink.organization_members as member
  where member.organization_id = v_organization.id
    and member.user_id = v_user_id;

  select * into v_workspace
  from openlink.workspaces as workspace
  where workspace.organization_id = v_organization.id
  limit 1;

  update openlink.profiles
  set organization_onboarding_completed = true,
      updated_at = now()
  where user_id = v_user_id;

  return query
  select v_organization.id, v_organization.name, v_organization.slug,
         v_workspace.id, v_workspace.slug, v_member_role::text;
end;
$$;

create or replace function openlink.join_organization(p_code text)
returns table (
  organization_id uuid,
  organization_name text,
  organization_slug text,
  workspace_id uuid,
  workspace_slug text,
  member_role text
)
language sql
security invoker
set search_path = ''
as $$
  select * from openlink_private.join_organization_by_code(p_code);
$$;

revoke all on schema openlink_private from public, anon;
grant usage on schema openlink_private to authenticated, service_role;

revoke all on function openlink_private.is_organization_member(uuid, uuid) from public, anon;
revoke all on function openlink_private.has_organization_role(uuid, text[], uuid) from public, anon;
revoke all on function openlink_private.is_organization_creator(uuid, uuid) from public, anon;
revoke all on function openlink_private.join_organization_by_code(text) from public, anon;

grant execute on function openlink_private.is_organization_member(uuid, uuid) to authenticated, service_role;
grant execute on function openlink_private.has_organization_role(uuid, text[], uuid) to authenticated, service_role;
grant execute on function openlink_private.is_organization_creator(uuid, uuid) to authenticated, service_role;
grant execute on function openlink_private.join_organization_by_code(text) to authenticated, service_role;

revoke all on table openlink.organizations from anon, authenticated;
revoke all on table openlink.organization_members from anon, authenticated;

grant select (id, name, slug, created_by, created_at, updated_at), insert, update (name, slug, updated_at), delete
  on table openlink.organizations to authenticated;
grant select, insert
  on table openlink.organization_members to authenticated;

grant select, insert, update, delete
  on table openlink.organizations, openlink.organization_members to service_role;

revoke all on function openlink.create_organization(text, text) from public, anon;
revoke all on function openlink.join_organization(text) from public, anon;
grant execute on function openlink.create_organization(text, text) to authenticated, service_role;
grant execute on function openlink.join_organization(text) to authenticated, service_role;

notify pgrst, 'reload schema';
