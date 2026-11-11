-- Bot runtime readiness is durable application state, not a UI assumption.
-- A Bot row can exist before its Agent Host lease succeeds; only a confirmed
-- Agent Host lease marks the Bot ready.

alter table openlink.bots
  add column if not exists runtime_status text not null default 'pending',
  add column if not exists runtime_ready_at timestamptz,
  add column if not exists runtime_last_error text,
  add column if not exists runtime_checked_at timestamptz;

alter table openlink.bots
  drop constraint if exists bots_runtime_status_check;

alter table openlink.bots
  add constraint bots_runtime_status_check
  check (runtime_status in ('pending', 'provisioning', 'ready', 'failed'));

alter table openlink.bots
  drop constraint if exists bots_runtime_error_length;

alter table openlink.bots
  add constraint bots_runtime_error_length
  check (runtime_last_error is null or char_length(runtime_last_error) <= 2000);

notify pgrst, 'reload schema';
