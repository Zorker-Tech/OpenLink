-- Keep the coarse runtime lifecycle stable for scheduling while exposing the
-- concrete provisioning phase needed by the UI and operators. A phase is a
-- display-safe state identifier; diagnostic text remains in last_error.

alter table openlink.project_runtimes
  add column if not exists provisioning_phase text not null default 'queued',
  add column if not exists provisioning_phase_updated_at timestamptz not null default now();

alter table openlink.project_runtimes
  drop constraint if exists project_runtimes_provisioning_phase_check;

alter table openlink.project_runtimes
  add constraint project_runtimes_provisioning_phase_check
  check (provisioning_phase in (
    'queued', 'claimed', 'starting_vm', 'configuring_runtime',
    'starting_project_database', 'starting_agent_services',
    'connecting_services', 'retry_wait', 'ready', 'stopped',
    'deleting', 'failed'
  ));

update openlink.project_runtimes
set provisioning_phase = case
      when status = 'ready' then 'ready'
      when status = 'stopped' then 'stopped'
      when status = 'deleting' then 'deleting'
      when status = 'error' and provisioning_next_attempt_at is not null
        and provisioning_next_attempt_at < now() + interval '180 days' then 'retry_wait'
      when status = 'error' then 'failed'
      when provisioning_claimed_by is not null then 'claimed'
      else 'queued'
    end,
    provisioning_phase_updated_at = updated_at,
    -- Ready rows cannot be claimed again. Clear leases left behind when a
    -- heartbeat raced the final ready projection in older provisioners.
    provisioning_claimed_by = case when status = 'ready' then null else provisioning_claimed_by end,
    provisioning_lease_expires_at = case when status = 'ready' then null else provisioning_lease_expires_at end;
