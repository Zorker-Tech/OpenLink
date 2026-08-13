-- Project-owned execution boundaries.
-- Every workspace has one system Draft project so a chat never falls back to
-- a global host workspace.

alter table openlink.projects
  add column if not exists is_default boolean not null default false;

update openlink.projects
set is_default = false
where is_default is null;

create unique index if not exists projects_workspace_default_idx
  on openlink.projects(workspace_id)
  where is_default;

-- Personal workspaces and organization workspaces both get a deterministic
-- Draft project. Organizations use the organization creator as the row owner;
-- access is still governed by the workspace policies.
insert into openlink.projects (
  workspace_id,
  created_by,
  name,
  slug,
  kind,
  source_type,
  source_url,
  description,
  status,
  is_default
)
select
  workspace.id,
  coalesce(workspace.owner_id, organization.created_by),
  'Draft',
  'draft',
  'code',
  'blank',
  null,
  '默认项目：未指定项目的聊天会话在此运行。',
  'active',
  true
from openlink.workspaces as workspace
left join openlink.organizations as organization on organization.id = workspace.organization_id
where coalesce(workspace.owner_id, organization.created_by) is not null
on conflict (workspace_id, slug) do update
set is_default = true,
    status = 'active',
    updated_at = now();

update openlink.chat_sessions as session
set project_id = project.id
from openlink.projects as project
where session.project_id is null
  and project.workspace_id = session.workspace_id
  and project.is_default;

alter table openlink.chat_sessions
  alter column project_id set not null;

drop index if exists openlink.chat_sessions_project_id_idx;
create index if not exists chat_sessions_project_id_idx
  on openlink.chat_sessions(project_id);

create table if not exists openlink.project_runtimes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references openlink.projects(id) on delete cascade,
  backend text not null default 'podman-machine',
  machine_name text not null unique,
  workspace_path text not null,
  opensandbox_endpoint text,
  browser_host_endpoint text,
  status text not null default 'provisioning',
  desired_cpus integer not null default 4,
  desired_memory_mb integer not null default 8192,
  desired_disk_gb integer not null default 64,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  stopped_at timestamptz,
  constraint project_runtimes_backend_check check (backend in ('podman-machine', 'remote-podman-machine')),
  constraint project_runtimes_status_check check (status in ('provisioning', 'ready', 'stopped', 'error', 'deleting')),
  constraint project_runtimes_machine_name_check check (machine_name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  constraint project_runtimes_workspace_path_check check (workspace_path like '/%'),
  constraint project_runtimes_resources_check check (
    desired_cpus between 1 and 64
    and desired_memory_mb between 512 and 262144
    and desired_disk_gb between 10 and 4096
  )
);

create index if not exists project_runtimes_status_idx
  on openlink.project_runtimes(status, updated_at desc);

alter table openlink.project_runtimes enable row level security;

drop policy if exists "project_runtimes_select_accessible" on openlink.project_runtimes;
create policy "project_runtimes_select_accessible"
  on openlink.project_runtimes
  for select
  to authenticated
  using (
    exists (
      select 1
      from openlink.projects as project
      join openlink.workspaces as workspace on workspace.id = project.workspace_id
      where project.id = project_runtimes.project_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or (
            workspace.scope_type = 'organization'
            and openlink_private.is_organization_member(workspace.organization_id)
          )
        )
    )
  );

drop policy if exists "project_runtimes_insert_governed" on openlink.project_runtimes;
create policy "project_runtimes_insert_governed"
  on openlink.project_runtimes
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from openlink.projects as project
      join openlink.workspaces as workspace on workspace.id = project.workspace_id
      where project.id = project_runtimes.project_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(workspace.organization_id, array['owner', 'admin'])
          )
        )
    )
  );

drop policy if exists "project_runtimes_update_governed" on openlink.project_runtimes;
create policy "project_runtimes_update_governed"
  on openlink.project_runtimes
  for update
  to authenticated
  using (
    exists (
      select 1
      from openlink.projects as project
      join openlink.workspaces as workspace on workspace.id = project.workspace_id
      where project.id = project_runtimes.project_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(workspace.organization_id, array['owner', 'admin'])
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from openlink.projects as project
      join openlink.workspaces as workspace on workspace.id = project.workspace_id
      where project.id = project_runtimes.project_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(workspace.organization_id, array['owner', 'admin'])
          )
        )
    )
  );

drop policy if exists "project_runtimes_delete_governed" on openlink.project_runtimes;
create policy "project_runtimes_delete_governed"
  on openlink.project_runtimes
  for delete
  to authenticated
  using (
    exists (
      select 1
      from openlink.projects as project
      join openlink.workspaces as workspace on workspace.id = project.workspace_id
      where project.id = project_runtimes.project_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(workspace.organization_id, array['owner', 'admin'])
          )
        )
    )
  );

revoke all on table openlink.project_runtimes from anon, authenticated;
grant select on table openlink.project_runtimes to authenticated;
grant select, insert, update, delete on table openlink.project_runtimes to service_role;
grant select (is_default) on table openlink.projects to authenticated;
