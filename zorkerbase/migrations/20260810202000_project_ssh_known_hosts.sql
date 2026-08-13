-- Strict SSH host-key verification is part of a Project's immutable execution
-- target.  Do not use trust-on-first-use for a project that can run agents.

alter table openlink.projects
  add column if not exists ssh_known_hosts text;

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
      and ssh_known_hosts is null
      and ssh_encrypted_private_key is null
      and ssh_private_key_iv is null
      and ssh_private_key_tag is null
      and ssh_private_key_hint is null
      and ssh_encryption_version is null
    )
    or
    (
      execution_mode = 'ssh'
      and ssh_host ~ '^[A-Za-z0-9][A-Za-z0-9.:[\\]-]{0,253}$'
      and ssh_port between 1 and 65535
      and ssh_user ~ '^[A-Za-z_][A-Za-z0-9_-]{0,63}$'
      and ssh_remote_root ~ '^/(?:[A-Za-z0-9._-]+/?)*$'
      and ssh_known_hosts is not null
      and length(ssh_known_hosts) between 32 and 16384
      and ssh_encrypted_private_key is not null
      and ssh_private_key_iv is not null
      and ssh_private_key_tag is not null
      and ssh_private_key_hint is not null
      and ssh_encryption_version = 1
    )
  );

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
    or new.ssh_known_hosts is distinct from old.ssh_known_hosts
    or new.ssh_encrypted_private_key is distinct from old.ssh_encrypted_private_key
    or new.ssh_private_key_iv is distinct from old.ssh_private_key_iv
    or new.ssh_private_key_tag is distinct from old.ssh_private_key_tag
    or new.ssh_private_key_hint is distinct from old.ssh_private_key_hint
    or new.ssh_encryption_version is distinct from old.ssh_encryption_version
  then
    raise exception using errcode = '23514', message = 'Project execution target is immutable after creation';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_reject_execution_target_change on openlink.projects;
create trigger projects_reject_execution_target_change
before update of execution_mode, ssh_host, ssh_port, ssh_user, ssh_remote_root,
  ssh_known_hosts, ssh_encrypted_private_key, ssh_private_key_iv,
  ssh_private_key_tag, ssh_private_key_hint, ssh_encryption_version
on openlink.projects
for each row execute function openlink_private.reject_project_execution_target_change();

notify pgrst, 'reload schema';
