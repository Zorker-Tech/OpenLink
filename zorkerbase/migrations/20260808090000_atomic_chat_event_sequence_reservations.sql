-- Allocate chat event sequence ranges atomically. Reading MAX(sequence) in the
-- application and inserting later is racy when two tabs submit/retry the same
-- Cloud session before either stream has flushed its persistence queue.
create table if not exists openlink.chat_session_event_counters (
  session_id text primary key,
  user_id uuid not null,
  next_sequence bigint not null check (next_sequence >= 0),
  constraint chat_session_event_counters_owner_fkey
    foreign key (session_id, user_id)
    references openlink.chat_sessions(id, user_id)
    on delete cascade
);

alter table openlink.chat_session_event_counters enable row level security;

drop policy if exists "chat_session_event_counters_own" on openlink.chat_session_event_counters;
create policy "chat_session_event_counters_own"
  on openlink.chat_session_event_counters
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table openlink.chat_session_event_counters from anon, authenticated;
grant select, insert, update on table openlink.chat_session_event_counters to authenticated;
grant select, insert, update, delete on table openlink.chat_session_event_counters to service_role;

create or replace function openlink.reserve_chat_event_sequences(
  p_session_id text,
  p_user_id uuid,
  p_count integer
)
returns bigint
language plpgsql
set search_path = openlink, pg_temp
as $$
declare
  v_start bigint;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat event sequence owner mismatch' using errcode = '42501';
  end if;
  if p_count < 1 or p_count > 1000000 then
    raise exception 'chat event sequence reservation is invalid' using errcode = '22023';
  end if;

  insert into openlink.chat_session_event_counters(session_id, user_id, next_sequence)
  values (
    p_session_id,
    p_user_id,
    coalesce((
      select max(sequence) + 1
      from openlink.chat_session_events
      where session_id = p_session_id and user_id = p_user_id
    ), 0)
  )
  on conflict (session_id) do nothing;

  update openlink.chat_session_event_counters
  set next_sequence = next_sequence + p_count
  where session_id = p_session_id and user_id = p_user_id
  returning next_sequence - p_count into v_start;

  if v_start is null then
    raise exception 'chat session does not belong to user' using errcode = '42501';
  end if;
  return v_start;
end;
$$;

revoke all on function openlink.reserve_chat_event_sequences(text, uuid, integer) from public;
grant execute on function openlink.reserve_chat_event_sequences(text, uuid, integer) to authenticated;
grant execute on function openlink.reserve_chat_event_sequences(text, uuid, integer) to service_role;
