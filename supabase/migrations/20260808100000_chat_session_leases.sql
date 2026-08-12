-- Serialize prompts for a Cloud chat session across Agent Host instances.
-- The Pi native snapshot is append-only, but two concurrent prompts can still
-- fork the same leaf when they are handled by different web/Agent Host
-- processes. A short database lease makes the session boundary authoritative;
-- an expired lease is recoverable after a crashed request.
create table if not exists openlink.chat_session_leases (
  session_id text primary key,
  user_id uuid not null,
  holder_id text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint chat_session_leases_owner_fkey
    foreign key (session_id, user_id)
    references openlink.chat_sessions(id, user_id)
    on delete cascade,
  constraint chat_session_leases_holder_check check (holder_id ~ '^[A-Za-z0-9_-]{16,128}$')
);

alter table openlink.chat_session_leases enable row level security;

drop policy if exists "chat_session_leases_own" on openlink.chat_session_leases;
create policy "chat_session_leases_own"
  on openlink.chat_session_leases
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table openlink.chat_session_leases from anon, authenticated;
grant select, insert, update, delete on table openlink.chat_session_leases to authenticated;
grant select, insert, update, delete on table openlink.chat_session_leases to service_role;

create or replace function openlink.acquire_chat_session_lease(
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
  acquired boolean := false;
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

  insert into openlink.chat_session_leases(session_id, user_id, holder_id, expires_at, updated_at)
  values (p_session_id, p_user_id, p_holder_id, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (session_id) do update
    set user_id = excluded.user_id,
        holder_id = excluded.holder_id,
        expires_at = excluded.expires_at,
        updated_at = now()
    where openlink.chat_session_leases.user_id = p_user_id
      and (openlink.chat_session_leases.expires_at <= now()
        or openlink.chat_session_leases.holder_id = p_holder_id)
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function openlink.release_chat_session_lease(
  p_session_id text,
  p_user_id uuid,
  p_holder_id text
)
returns boolean
language plpgsql
set search_path = openlink, pg_temp
as $$
declare
  released boolean := false;
  deleted_count integer := 0;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat session lease owner mismatch' using errcode = '42501';
  end if;
  delete from openlink.chat_session_leases
   where session_id = p_session_id
     and user_id = p_user_id
     and holder_id = p_holder_id;
  get diagnostics deleted_count = row_count;
  released := deleted_count > 0;
  return released;
end;
$$;

revoke all on function openlink.acquire_chat_session_lease(text, uuid, text, integer) from public;
revoke all on function openlink.release_chat_session_lease(text, uuid, text) from public;
grant execute on function openlink.acquire_chat_session_lease(text, uuid, text, integer) to authenticated;
grant execute on function openlink.release_chat_session_lease(text, uuid, text) to authenticated;

notify pgrst, 'reload schema';
