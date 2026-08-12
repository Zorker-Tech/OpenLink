-- Server-only audit record for explicit Cloud -> Local data imports. This
-- table exists in both topologies so their schemas remain identical, but is
-- writable only by service_role and is never part of browser authorization.
create table if not exists openlink.local_runtime_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  source_updated_at timestamptz,
  completed_at timestamptz not null default now(),
  record_counts jsonb not null default '{}'::jsonb
);

alter table openlink.local_runtime_sync_state enable row level security;
revoke all on table openlink.local_runtime_sync_state from anon, authenticated;
grant select, insert, update, delete on table openlink.local_runtime_sync_state to service_role;

notify pgrst, 'reload schema';
