create table if not exists openlink.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null,
  slug text not null,
  kind text not null,
  source_type text not null default 'blank',
  source_url text,
  description text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_workspace_slug_unique unique (workspace_id, slug),
  constraint projects_name_length check (char_length(name) between 1 and 100),
  constraint projects_slug_length check (char_length(slug) between 1 and 100),
  constraint projects_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint projects_kind_check check (kind in ('code', 'research')),
  constraint projects_source_type_check check (source_type in ('blank', 'github')),
  constraint projects_source_shape_check check (
    (source_type = 'blank' and source_url is null)
    or
    (source_type = 'github' and source_url ~ '^https://github\\.com/[^/]+/[^/]+/?$')
  ),
  constraint projects_description_length check (char_length(description) <= 2000),
  constraint projects_status_check check (status in ('active', 'archived'))
);

create index if not exists projects_workspace_updated_idx
  on openlink.projects(workspace_id, updated_at desc);

create index if not exists projects_created_by_idx
  on openlink.projects(created_by);

alter table openlink.projects enable row level security;

drop policy if exists "projects_select_accessible" on openlink.projects;
create policy "projects_select_accessible"
  on openlink.projects
  for select
  to authenticated
  using (
    exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = projects.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (
            workspace.scope_type = 'organization'
            and openlink_private.is_organization_member(workspace.organization_id)
          )
        )
    )
  );

drop policy if exists "projects_insert_governed" on openlink.projects;
create policy "projects_insert_governed"
  on openlink.projects
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = projects.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(
              workspace.organization_id,
              array['owner', 'admin']
            )
          )
        )
    )
  );

drop policy if exists "projects_update_governed" on openlink.projects;
create policy "projects_update_governed"
  on openlink.projects
  for update
  to authenticated
  using (
    exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = projects.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(
              workspace.organization_id,
              array['owner', 'admin']
            )
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = projects.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(
              workspace.organization_id,
              array['owner', 'admin']
            )
          )
        )
    )
  );

drop policy if exists "projects_delete_governed" on openlink.projects;
create policy "projects_delete_governed"
  on openlink.projects
  for delete
  to authenticated
  using (
    exists (
      select 1
      from openlink.workspaces as workspace
      where workspace.id = projects.workspace_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or
          (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(
              workspace.organization_id,
              array['owner', 'admin']
            )
          )
        )
    )
  );

revoke all on table openlink.projects from anon, authenticated;
grant select, insert, delete on table openlink.projects to authenticated;
grant update (name, slug, source_url, description, status, updated_at)
  on table openlink.projects to authenticated;
grant select, insert, update, delete on table openlink.projects to service_role;

alter table openlink.chat_sessions
  add column if not exists project_id uuid references openlink.projects(id) on delete set null;

create index if not exists chat_sessions_project_id_idx
  on openlink.chat_sessions(project_id)
  where project_id is not null;

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
          (
            workspace.scope_type = 'organization'
            and openlink_private.is_organization_member(workspace.organization_id)
          )
        )
    )
    and (
      project_id is null
      or exists (
        select 1
        from openlink.projects as project
        where project.id = chat_sessions.project_id
          and project.workspace_id = chat_sessions.workspace_id
      )
    )
  );

notify pgrst, 'reload schema';
