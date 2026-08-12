-- A Project has one immutable execution target. Local Projects run in the
-- local Project VM; SSH Projects create that Project VM on the specified
-- Linux target. Secret key material is encrypted by the application and is
-- intentionally not exposed through the authenticated role.

alter table openlink.projects
  add column if not exists execution_mode text not null default 'local',
  add column if not exists ssh_host text,
  add column if not exists ssh_port integer,
  add column if not exists ssh_user text,
  add column if not exists ssh_remote_root text,
  add column if not exists ssh_encrypted_private_key text,
  add column if not exists ssh_private_key_iv text,
  add column if not exists ssh_private_key_tag text,
  add column if not exists ssh_private_key_hint text,
  add column if not exists ssh_encryption_version integer;

alter table openlink.projects
  drop constraint if exists projects_execution_mode_check,
  add constraint projects_execution_mode_check
  check (execution_mode in ('local', 'ssh'));

alter table openlink.projects
  drop constraint if exists projects_ssh_target_shape_check,
  add constraint projects_ssh_target_shape_check
  check (
    (
      execution_mode = 'local'
      and ssh_host is null
      and ssh_port is null
      and ssh_user is null
      and ssh_remote_root is null
      and ssh_encrypted_private_key is null
      and ssh_private_key_iv is null
      and ssh_private_key_tag is null
      and ssh_private_key_hint is null
      and ssh_encryption_version is null
    )
    or
    (
      execution_mode = 'ssh'
      and ssh_host ~ '^[A-Za-z0-9][A-Za-z0-9.:[\]-]{0,253}$'
      and ssh_port between 1 and 65535
      and ssh_user ~ '^[A-Za-z_][A-Za-z0-9_-]{0,63}$'
      and ssh_remote_root ~ '^/(?:[A-Za-z0-9._-]+/?)*$'
      and ssh_encrypted_private_key is not null
      and ssh_private_key_iv is not null
      and ssh_private_key_tag is not null
      and ssh_private_key_hint is not null
      and ssh_encryption_version = 1
    )
  );

create index if not exists projects_execution_mode_idx
  on openlink.projects(workspace_id, execution_mode, updated_at desc);

create or replace function openlink_private.reject_project_execution_target_change()
returns trigger
language plpgsql
set search_path = openlink, pg_catalog
as $$
begin
  if new.execution_mode is distinct from old.execution_mode
    or new.ssh_host is distinct from old.ssh_host
    or new.ssh_port is distinct from old.ssh_port
    or new.ssh_user is distinct from old.ssh_user
    or new.ssh_remote_root is distinct from old.ssh_remote_root
    or new.ssh_encrypted_private_key is distinct from old.ssh_encrypted_private_key
    or new.ssh_private_key_iv is distinct from old.ssh_private_key_iv
    or new.ssh_private_key_tag is distinct from old.ssh_private_key_tag
    or new.ssh_private_key_hint is distinct from old.ssh_private_key_hint
    or new.ssh_encryption_version is distinct from old.ssh_encryption_version
  then
    raise exception using
      errcode = '23514',
      message = 'Project execution target is immutable after creation';
  end if;
  return new;
end;
$$;

revoke all on function openlink_private.reject_project_execution_target_change()
  from public, anon, authenticated;

drop trigger if exists projects_reject_execution_target_change
  on openlink.projects;

create trigger projects_reject_execution_target_change
before update of execution_mode, ssh_host, ssh_port, ssh_user, ssh_remote_root,
  ssh_encrypted_private_key, ssh_private_key_iv, ssh_private_key_tag,
  ssh_private_key_hint, ssh_encryption_version
on openlink.projects
for each row execute function openlink_private.reject_project_execution_target_change();

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
    case when new.execution_mode = 'ssh' then 'qemu-kvm' else 'podman-machine' end,
    'openlink-project-' || left(replace(new.id::text, '-', ''), 24),
    case
      when new.execution_mode = 'ssh'
        then new.ssh_remote_root || '/projects/' || new.id::text || '/workspace'
      else '/var/lib/openlink/projects/' || new.id::text || '/workspace'
    end,
    'provisioning',
    new.disk_mode
  )
  on conflict (project_id) do nothing;
  return new;
end;
$$;

revoke all on function openlink_private.initialize_project_runtime()
  from public, anon, authenticated;

-- Existing projects predate SSH targets and are explicitly local.
update openlink.projects
set execution_mode = 'local'
where execution_mode is null;

notify pgrst, 'reload schema';
