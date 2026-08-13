-- Append Pi's native JSONL entries under a row lock. The application cannot
-- safely compute MAX(entry_order)+1 when two Agent Host processes overlap (for
-- example while a lease is expiring or during a rolling deployment).
create or replace function openlink.append_chat_session_pi_entries(
  p_session_id text,
  p_user_id uuid,
  p_entries jsonb
)
returns void
language plpgsql
set search_path = openlink, pg_temp
as $$
declare
  entry jsonb;
  v_entry_id text;
  v_entry_type text;
  v_entry_timestamp timestamptz;
  v_parent_id text;
  v_next_order bigint;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Pi session entry owner mismatch' using errcode = '42501';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'Pi session entries must be an array' using errcode = '22023';
  end if;

  -- The header upsert happens immediately before this call. Locking it makes
  -- the ordinal allocation and duplicate check one atomic critical section.
  perform 1
    from openlink.chat_session_pi_sessions
   where session_id = p_session_id
     and user_id = p_user_id
   for update;
  if not found then
    raise exception 'Pi session does not belong to user' using errcode = '42501';
  end if;

  select coalesce(max(existing.entry_order) + 1, 0)
    into v_next_order
    from openlink.chat_session_pi_entries as existing
   where existing.session_id = p_session_id
     and existing.user_id = p_user_id;

  for entry in select value from jsonb_array_elements(p_entries)
  loop
    v_entry_id := entry->>'id';
    v_entry_type := entry->>'type';
    v_entry_timestamp := (entry->>'timestamp')::timestamptz;
    v_parent_id := nullif(entry->>'parentId', '');
    if v_entry_id is null or v_entry_type is null or v_entry_timestamp is null then
      raise exception 'Pi session entry is invalid' using errcode = '22023';
    end if;

    if not exists (
      select 1
        from openlink.chat_session_pi_entries as existing
       where existing.session_id = p_session_id
         and existing.entry_id = v_entry_id
    ) then
      insert into openlink.chat_session_pi_entries(
        session_id,
        user_id,
        entry_id,
        entry_order,
        parent_id,
        entry_type,
        entry_timestamp,
        entry
      ) values (
        p_session_id,
        p_user_id,
        v_entry_id,
        v_next_order,
        v_parent_id,
        v_entry_type,
        v_entry_timestamp,
        entry
      ) on conflict (session_id, entry_id) do nothing;
      if found then v_next_order := v_next_order + 1; end if;
    end if;
  end loop;
end;
$$;

revoke all on function openlink.append_chat_session_pi_entries(text, uuid, jsonb) from public;
grant execute on function openlink.append_chat_session_pi_entries(text, uuid, jsonb) to authenticated;
grant execute on function openlink.append_chat_session_pi_entries(text, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
