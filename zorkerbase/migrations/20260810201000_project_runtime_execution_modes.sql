-- Mirror the immutable Project execution target in the runtime queue. Local
-- hosts must only claim local work; SSH work is reserved for its target-aware
-- remote provisioner and can never silently fall back to the local machine.

alter table openlink.project_runtimes
  add column if not exists execution_mode text not null default 'local';

update openlink.project_runtimes as runtime
set execution_mode = project.execution_mode
from openlink.projects as project
where project.id = runtime.project_id
  and runtime.execution_mode is distinct from project.execution_mode;

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_execution_mode_check,
  add constraint project_runtimes_execution_mode_check
  check (execution_mode in ('local', 'ssh'));

create unique index if not exists projects_id_execution_mode_idx
  on openlink.projects(id, execution_mode);

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_project_execution_mode_fkey,
  add constraint project_runtimes_project_execution_mode_fkey
  foreign key (project_id, execution_mode)
  references openlink.projects(id, execution_mode)
  on update restrict
  on delete cascade;

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
    disk_mode,
    execution_mode
  ) values (
    new.id,
    case when new.execution_mode = 'ssh' then 'qemu-kvm' else 'podman-machine' end,
    'openlink-project-' || left(replace(new.id::text, '-', ''), 24),
    case
      when new.execution_mode = 'ssh'
        then new.ssh_remote_root || '/projects/' || new.id::text || '/workspace'
      else '/var/lib/openlink/projects/' || new.id::text || '/workspace'
    end,
    'provisioning',
    new.disk_mode,
    new.execution_mode
  )
  on conflict (project_id) do nothing;
  return new;
end;
$$;

revoke all on function openlink_private.initialize_project_runtime()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
