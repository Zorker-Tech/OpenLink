-- Keep a long-running Cloud Pi prompt exclusive for its full lifetime.
-- The initial lease is deliberately short enough to recover after a crash;
-- active streams renew it periodically while they are still consuming Agent
-- Host output.
create or replace function openlink.renew_chat_session_lease(
  p_session_id text,
  p_user_id uuid,
  p_holder_id text,
  p_ttl_seconds integer default 1800
)
returns boolean
language plpgsql
set search_path = openlink, pg_temp
as $$
declare
  renewed boolean := false;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat session lease owner mismatch' using errcode = '42501';
  end if;
  if p_ttl_seconds < 60 or p_ttl_seconds > 3600 then
    raise exception 'chat session lease ttl is invalid' using errcode = '22023';
  end if;
  if p_holder_id !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'chat session lease holder is invalid' using errcode = '22023';
  end if;

  update openlink.chat_session_leases
     set expires_at = now() + make_interval(secs => p_ttl_seconds),
         updated_at = now()
   where session_id = p_session_id
     and user_id = p_user_id
     and holder_id = p_holder_id
     and expires_at > now()
  returning true into renewed;

  return coalesce(renewed, false);
end;
$$;

revoke all on function openlink.renew_chat_session_lease(text, uuid, text, integer) from public;
grant execute on function openlink.renew_chat_session_lease(text, uuid, text, integer) to authenticated;

notify pgrst, 'reload schema';
