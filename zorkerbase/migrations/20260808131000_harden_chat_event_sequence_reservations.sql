-- If events were inserted by an older worker after the counter row was
-- created, bring the counter forward before reserving a new range. This keeps
-- the event primary key collision-free across rolling deployments.
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
  v_event_next bigint;
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

  select coalesce(max(sequence) + 1, 0)
    into v_event_next
    from openlink.chat_session_events
   where session_id = p_session_id
     and user_id = p_user_id;

  update openlink.chat_session_event_counters
     set next_sequence = greatest(next_sequence, v_event_next) + p_count
   where session_id = p_session_id
     and user_id = p_user_id
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

notify pgrst, 'reload schema';
