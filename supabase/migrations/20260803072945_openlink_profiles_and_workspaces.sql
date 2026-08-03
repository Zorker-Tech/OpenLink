create schema if not exists openlink;

create table if not exists openlink.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text,
  nickname_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_nickname_length check (
    nickname is null or char_length(nickname) between 1 and 64
  )
);

create table if not exists openlink.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_length check (char_length(name) between 1 and 64),
  constraint workspaces_slug_length check (char_length(slug) between 1 and 80)
);

create index if not exists workspaces_owner_id_idx
  on openlink.workspaces(owner_id);

alter table openlink.profiles enable row level security;
alter table openlink.workspaces enable row level security;

drop policy if exists "profiles_select_own" on openlink.profiles;
create policy "profiles_select_own"
  on openlink.profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "profiles_insert_own" on openlink.profiles;
create policy "profiles_insert_own"
  on openlink.profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "profiles_update_own" on openlink.profiles;
create policy "profiles_update_own"
  on openlink.profiles
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "workspaces_select_own" on openlink.workspaces;
create policy "workspaces_select_own"
  on openlink.workspaces
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "workspaces_insert_own" on openlink.workspaces;
create policy "workspaces_insert_own"
  on openlink.workspaces
  for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "workspaces_update_own" on openlink.workspaces;
create policy "workspaces_update_own"
  on openlink.workspaces
  for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "workspaces_delete_own" on openlink.workspaces;
create policy "workspaces_delete_own"
  on openlink.workspaces
  for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

grant usage on schema openlink to anon, authenticated, service_role;
revoke all on table openlink.profiles from anon;
revoke all on table openlink.workspaces from anon;
grant select, insert, update on table openlink.profiles to authenticated, service_role;
grant select, insert, update, delete on table openlink.workspaces to authenticated, service_role;

alter role authenticator
  set pgrst.db_schemas = 'public, storage, graphql_public, openlink';

notify pgrst, 'reload config';
