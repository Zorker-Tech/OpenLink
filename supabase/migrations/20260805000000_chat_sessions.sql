create table if not exists openlink.chat_sessions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  title text not null default 'AI Elements 集成',
  initial_prompt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_sessions_id_format check (id ~ '^[A-Za-z0-9]{11}$'),
  constraint chat_sessions_title_length check (char_length(title) between 1 and 120),
  constraint chat_sessions_prompt_length check (char_length(initial_prompt) <= 10000)
);

create index if not exists chat_sessions_user_created_idx
  on openlink.chat_sessions(user_id, created_at desc);

alter table openlink.chat_sessions enable row level security;

drop policy if exists "chat_sessions_select_own" on openlink.chat_sessions;
create policy "chat_sessions_select_own"
  on openlink.chat_sessions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "chat_sessions_insert_accessible_workspace" on openlink.chat_sessions;
create policy "chat_sessions_insert_accessible_workspace"
  on openlink.chat_sessions
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = chat_sessions.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (workspace.scope_type = 'organization' and openlink_private.is_organization_member(workspace.organization_id))
        )
    )
  );

drop policy if exists "chat_sessions_update_own" on openlink.chat_sessions;
create policy "chat_sessions_update_own"
  on openlink.chat_sessions
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "chat_sessions_delete_own" on openlink.chat_sessions;
create policy "chat_sessions_delete_own"
  on openlink.chat_sessions
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table openlink.chat_sessions from anon, authenticated;
grant select, insert, update, delete on table openlink.chat_sessions to authenticated;
grant select, insert, update, delete on table openlink.chat_sessions to service_role;

notify pgrst, 'reload schema';
