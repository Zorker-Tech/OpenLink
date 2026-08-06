alter table openlink.chat_sessions
  drop constraint if exists chat_sessions_id_user_unique,
  add constraint chat_sessions_id_user_unique unique (id, user_id);

create table if not exists openlink.chat_session_pi_sessions (
  session_id text primary key,
  user_id uuid not null,
  pi_session_id text not null,
  version integer,
  header jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_session_pi_sessions_owner_fkey
    foreign key (session_id, user_id)
    references openlink.chat_sessions(id, user_id)
    on delete cascade,
  constraint chat_session_pi_sessions_pi_id_unique unique (user_id, pi_session_id),
  constraint chat_session_pi_sessions_header_check check (
    header->>'type' = 'session'
    and header->>'id' = pi_session_id
  )
);

create table if not exists openlink.chat_session_pi_entries (
  session_id text not null,
  user_id uuid not null,
  entry_id text not null,
  parent_id text,
  entry_type text not null,
  entry_timestamp timestamptz not null,
  entry jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, entry_id),
  constraint chat_session_pi_entries_owner_fkey
    foreign key (session_id, user_id)
    references openlink.chat_sessions(id, user_id)
    on delete cascade,
  constraint chat_session_pi_entries_payload_check check (
    entry->>'id' = entry_id
    and entry->>'type' = entry_type
  )
);

create index if not exists chat_session_pi_entries_order_idx
  on openlink.chat_session_pi_entries(session_id, entry_timestamp, created_at);

create table if not exists openlink.chat_session_events (
  session_id text not null,
  user_id uuid not null,
  sequence bigint not null check (sequence >= 0),
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, sequence),
  constraint chat_session_events_owner_fkey
    foreign key (session_id, user_id)
    references openlink.chat_sessions(id, user_id)
    on delete cascade,
  constraint chat_session_events_event_unique unique (session_id, event_id),
  constraint chat_session_events_payload_check check (
    payload->>'id' = event_id
    and payload->>'type' = event_type
    and (payload->>'sequence')::bigint = sequence
    and payload->>'sessionId' = session_id
  )
);

create index if not exists chat_session_events_user_recent_idx
  on openlink.chat_session_events(user_id, occurred_at desc);

alter table openlink.chat_session_pi_sessions enable row level security;
alter table openlink.chat_session_pi_entries enable row level security;
alter table openlink.chat_session_events enable row level security;

drop policy if exists "chat_session_pi_sessions_own" on openlink.chat_session_pi_sessions;
create policy "chat_session_pi_sessions_own"
  on openlink.chat_session_pi_sessions
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "chat_session_pi_entries_own" on openlink.chat_session_pi_entries;
create policy "chat_session_pi_entries_own"
  on openlink.chat_session_pi_entries
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "chat_session_events_own" on openlink.chat_session_events;
create policy "chat_session_events_own"
  on openlink.chat_session_events
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table openlink.chat_session_pi_sessions from anon, authenticated;
revoke all on table openlink.chat_session_pi_entries from anon, authenticated;
revoke all on table openlink.chat_session_events from anon, authenticated;
grant select, insert, update on table openlink.chat_session_pi_sessions to authenticated;
grant select, insert, update on table openlink.chat_session_pi_entries to authenticated;
grant select, insert, update on table openlink.chat_session_events to authenticated;
grant select, insert, update, delete on table openlink.chat_session_pi_sessions to service_role;
grant select, insert, update, delete on table openlink.chat_session_pi_entries to service_role;
grant select, insert, update, delete on table openlink.chat_session_events to service_role;
