-- Project disk allocation is immutable desired state. Draft Projects are
-- always thin-provisioned; only manually-created Projects may choose thick.

alter table openlink.projects
  add column if not exists disk_mode text not null default 'thin';

update openlink.projects
set disk_mode = 'thin'
where disk_mode is null;

alter table openlink.projects
  drop constraint if exists projects_disk_mode_check;

alter table openlink.projects
  add constraint projects_disk_mode_check
  check (disk_mode in ('thin', 'thick'));

alter table openlink.projects
  drop constraint if exists projects_default_disk_mode_check;

alter table openlink.projects
  add constraint projects_default_disk_mode_check
  check (not is_default or disk_mode = 'thin');

-- The composite key lets project_runtimes carry the allocation mode in its
-- durable provisioning queue without allowing that projection to drift from
-- the owning Project.
create unique index if not exists projects_id_disk_mode_idx
  on openlink.projects(id, disk_mode);

alter table openlink.project_runtimes
  add column if not exists disk_mode text not null default 'thin';

update openlink.project_runtimes as runtime
set disk_mode = project.disk_mode
from openlink.projects as project
where project.id = runtime.project_id
  and runtime.disk_mode is distinct from project.disk_mode;

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_disk_mode_check;

alter table openlink.project_runtimes
  add constraint project_runtimes_disk_mode_check
  check (disk_mode in ('thin', 'thick'));

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_project_disk_mode_fkey;

alter table openlink.project_runtimes
  add constraint project_runtimes_project_disk_mode_fkey
  foreign key (project_id, disk_mode)
  references openlink.projects(id, disk_mode)
  on update restrict
  on delete cascade;

create or replace function openlink_private.reject_project_disk_mode_change()
returns trigger
language plpgsql
set search_path = openlink, pg_catalog
as $$
begin
  if new.disk_mode is distinct from old.disk_mode then
    raise exception using
      errcode = '23514',
      message = 'Project disk allocation mode is immutable after creation';
  end if;
  return new;
end;
$$;

revoke all on function openlink_private.reject_project_disk_mode_change()
  from public, anon, authenticated;

drop trigger if exists projects_reject_disk_mode_change
  on openlink.projects;

create trigger projects_reject_disk_mode_change
before update of disk_mode on openlink.projects
for each row execute function openlink_private.reject_project_disk_mode_change();

create or replace function openlink_private.initialize_project_runtime()
returns trigger
language plpgsql
security definer
set search_path = openlink, pg_catalog
as $$
begin
  insert into openlink.project_runtimes (
    project_id,
    backend,
    machine_name,
    workspace_path,
    status,
    disk_mode
  ) values (
    new.id,
    'podman-machine',
    'openlink-project-' || left(replace(new.id::text, '-', ''), 24),
    '/var/lib/openlink/projects/' || new.id::text || '/workspace',
    'provisioning',
    new.disk_mode
  )
  on conflict (project_id) do nothing;
  return new;
end;
$$;

revoke all on function openlink_private.initialize_project_runtime()
  from public, anon, authenticated;

-- Preserve eager onboarding: personal and organization Draft Projects enter
-- the provisioning queue as soon as their workspace exists, always as thin.
create or replace function openlink_private.initialize_workspace_draft_project()
returns trigger
language plpgsql
security definer
set search_path = openlink, pg_catalog
as $$
declare
  creator uuid;
begin
  select coalesce(new.owner_id, organization.created_by)
    into creator
  from openlink.organizations as organization
  where organization.id = new.organization_id;

  if creator is null then
    creator := new.owner_id;
  end if;
  if creator is null then
    return new;
  end if;

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
    is_default,
    disk_mode
  ) values (
    new.id,
    creator,
    'Draft',
    'draft',
    'code',
    'blank',
    null,
    '默认项目：未指定项目的聊天会话在此运行。',
    'waiting',
    true,
    'thin'
  )
  on conflict (workspace_id, slug) do update
    set is_default = true,
        status = case
          when openlink.projects.status = 'archived' then 'archived'
          else 'waiting'
        end,
        updated_at = now();
  return new;
end;
$$;

revoke all on function openlink_private.initialize_workspace_draft_project()
  from public, anon, authenticated;

