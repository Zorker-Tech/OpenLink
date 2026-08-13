-- Keep project metadata and VM lifecycle metadata in lockstep. The trigger only
-- records desired runtime state; the Agent Host performs privileged Podman
-- provisioning and advances status to ready/error.

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
    status
  ) values (
    new.id,
    'podman-machine',
    'openlink-project-' || left(replace(new.id::text, '-', ''), 24),
    '/var/lib/openlink/projects/' || new.id::text || '/workspace',
    'provisioning'
  )
  on conflict (project_id) do nothing;
  return new;
end;
$$;

revoke all on function openlink_private.initialize_project_runtime() from public, anon, authenticated;

drop trigger if exists projects_initialize_runtime on openlink.projects;
create trigger projects_initialize_runtime
after insert on openlink.projects
for each row execute function openlink_private.initialize_project_runtime();

insert into openlink.project_runtimes (
  project_id,
  backend,
  machine_name,
  workspace_path,
  status
)
select
  project.id,
  'podman-machine',
  'openlink-project-' || left(replace(project.id::text, '-', ''), 24),
  '/var/lib/openlink/projects/' || project.id::text || '/workspace',
  'provisioning'
from openlink.projects as project
where not exists (
  select 1 from openlink.project_runtimes as runtime where runtime.project_id = project.id
)
on conflict (project_id) do nothing;
