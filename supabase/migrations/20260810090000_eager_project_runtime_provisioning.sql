-- Projects are usable only after their isolated runtime is ready. Runtime rows
-- also act as a durable provisioning queue consumed by Agent Host.

alter table openlink.projects
  alter column status set default 'waiting';

alter table openlink.projects
  drop constraint if exists projects_status_check;

alter table openlink.projects
  add constraint projects_status_check
  check (status in ('waiting', 'active', 'archived'));

alter table openlink.project_runtimes
  add column if not exists provisioning_claimed_by text,
  add column if not exists provisioning_lease_expires_at timestamptz,
  add column if not exists provisioning_attempts integer not null default 0,
  add column if not exists provisioning_next_attempt_at timestamptz;

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_provisioning_claim_check;

alter table openlink.project_runtimes
  add constraint project_runtimes_provisioning_claim_check
  check (
    provisioning_claimed_by is null
    or provisioning_claimed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  );

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_provisioning_attempts_check;

alter table openlink.project_runtimes
  add constraint project_runtimes_provisioning_attempts_check
  check (provisioning_attempts between 0 and 1000000);

create index if not exists project_runtimes_provisioning_queue_idx
  on openlink.project_runtimes(
    provisioning_next_attempt_at,
    provisioning_lease_expires_at,
    created_at
  )
  where status in ('provisioning', 'stopped', 'error');

create or replace function openlink_private.sync_project_runtime_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = openlink, pg_catalog
as $$
begin
  update openlink.projects
  set status = case when new.status = 'ready' then 'active' else 'waiting' end,
      updated_at = now()
  where id = new.project_id
    and status <> 'archived';
  return new;
end;
$$;

revoke all on function openlink_private.sync_project_runtime_lifecycle()
  from public, anon, authenticated;

drop trigger if exists project_runtimes_sync_project_lifecycle
  on openlink.project_runtimes;

create trigger project_runtimes_sync_project_lifecycle
after insert or update of status on openlink.project_runtimes
for each row execute function openlink_private.sync_project_runtime_lifecycle();

-- The workspace trigger is the onboarding boundary for both personal and
-- organization Draft projects. Persist waiting immediately; Agent Host will
-- independently advance the Project after its VM and services are healthy.
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
    is_default
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
    true
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

-- Reconcile pre-existing rows, including Draft Projects created before eager
-- provisioning existed.
update openlink.projects as project
set status = case when runtime.status = 'ready' then 'active' else 'waiting' end,
    updated_at = now()
from openlink.project_runtimes as runtime
where runtime.project_id = project.id
  and project.status <> 'archived';

