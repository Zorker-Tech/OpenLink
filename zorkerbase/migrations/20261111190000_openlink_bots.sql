-- Persistent bots are application-owned records. Work-host owns each bot's
-- agent profile, avatar and transcript; the Project VM/OpenSandbox runtime is
-- reached through a dedicated hidden chat session per bot.

alter table openlink.chat_sessions
  add column if not exists surface text not null default 'code';

alter table openlink.chat_sessions
  drop constraint if exists chat_sessions_surface_check;

alter table openlink.chat_sessions
  add constraint chat_sessions_surface_check
  check (surface in ('code', 'bot'));

create index if not exists chat_sessions_surface_workspace_idx
  on openlink.chat_sessions(workspace_id, surface, updated_at desc);

create table if not exists openlink.bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  project_id uuid references openlink.projects(id) on delete set null,
  runtime_session_id text references openlink.chat_sessions(id) on delete set null,
  work_agent_id text not null,
  name text not null,
  description text not null default '',
  avatar_shape text not null default 'blob',
  avatar_color text not null default 'orange',
  provider_id text,
  model_id text,
  last_entry_text text not null default '',
  last_activity_at timestamptz not null default now(),
  last_viewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bots_work_agent_unique unique (work_agent_id),
  constraint bots_runtime_session_unique unique (runtime_session_id),
  constraint bots_name_length check (char_length(name) between 1 and 64),
  constraint bots_description_length check (char_length(description) <= 2000),
  constraint bots_avatar_shape_format check (avatar_shape ~ '^[a-z0-9-]{1,32}$'),
  constraint bots_avatar_color_format check (avatar_color ~ '^[a-z0-9-]{1,32}$'),
  constraint bots_work_agent_format check (work_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint bots_runtime_session_format check (runtime_session_id is null or runtime_session_id ~ '^[A-Za-z0-9]{11}$'),
  constraint bots_model_binding_complete check (
    (provider_id is null and model_id is null)
    or (provider_id is not null and model_id is not null)
  ),
  constraint bots_last_entry_length check (char_length(last_entry_text) <= 2000)
);

create index if not exists bots_user_workspace_updated_idx
  on openlink.bots(user_id, workspace_id, updated_at desc);

create index if not exists bots_workspace_updated_idx
  on openlink.bots(workspace_id, updated_at desc);

alter table openlink.bots enable row level security;

drop policy if exists "bots_select_own" on openlink.bots;
create policy "bots_select_own"
  on openlink.bots
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = bots.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (workspace.scope_type = 'organization' and openlink_private.is_organization_member(workspace.organization_id))
        )
    )
  );

drop policy if exists "bots_insert_own" on openlink.bots;
create policy "bots_insert_own"
  on openlink.bots
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = bots.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (workspace.scope_type = 'organization' and openlink_private.is_organization_member(workspace.organization_id))
        )
    )
  );

drop policy if exists "bots_update_own" on openlink.bots;
create policy "bots_update_own"
  on openlink.bots
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "bots_delete_own" on openlink.bots;
create policy "bots_delete_own"
  on openlink.bots
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table openlink.bots from anon, authenticated;
grant select, insert, update, delete on table openlink.bots to authenticated;
grant select, insert, update, delete on table openlink.bots to service_role;

notify pgrst, 'reload schema';
