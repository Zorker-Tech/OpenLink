-- Durable per-session run state. The browser stream is a transport, not the
-- owner of a turn: a run continues after the page detaches and its latest
-- status/process is visible from the session list and on reopen.
create table if not exists openlink.chat_session_runs (
  run_id uuid primary key,
  session_id text not null,
  user_id uuid not null,
  process_id text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  error_code text,
  constraint chat_session_runs_session_fkey
    foreign key (session_id)
    references openlink.chat_sessions(id)
    on delete cascade,
  constraint chat_session_runs_status_check
    check (status in ('running', 'completed', 'failed', 'cancelled')),
  constraint chat_session_runs_process_check
    check (process_id ~ '^[A-Za-z0-9_-]{16,128}$')
);

create index if not exists chat_session_runs_session_started_idx
  on openlink.chat_session_runs (session_id, started_at desc);
create index if not exists chat_session_runs_user_started_idx
  on openlink.chat_session_runs (user_id, started_at desc);

-- Session labels are durable, ordered, and user-owned. Empty by default so
-- existing rows need no backfill.
alter table openlink.chat_sessions
  add column if not exists labels text[] not null default '{}'::text[];

alter table openlink.chat_session_runs enable row level security;

drop policy if exists "chat_session_runs_own" on openlink.chat_session_runs;
create policy "chat_session_runs_own"
  on openlink.chat_session_runs
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table openlink.chat_session_runs from anon, authenticated;
grant select, insert, update, delete on table openlink.chat_session_runs to authenticated;
grant select, insert, update, delete on table openlink.chat_session_runs to service_role;

notify pgrst, 'reload schema';
