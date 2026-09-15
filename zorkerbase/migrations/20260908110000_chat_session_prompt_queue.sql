-- Persist composer follow-ups so refreshes and tab changes do not lose them.
-- A short claim serializes drainers; deletion only happens after the web client
-- observes the canonical durable message.user receipt from the events route.
create table if not exists openlink.chat_session_prompt_queue (
  id uuid primary key,
  session_id text not null,
  user_id uuid not null,
  message text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  provider_id text,
  model_id text,
  claim_token text,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_session_prompt_queue_owner_fkey
    foreign key (session_id, user_id)
    references openlink.chat_sessions(id, user_id)
    on delete cascade,
  constraint chat_session_prompt_queue_message_length check (char_length(message) <= 10000),
  constraint chat_session_prompt_queue_content_check check (message <> '' or jsonb_array_length(attachments) > 0),
  constraint chat_session_prompt_queue_attachments_check check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 24),
  constraint chat_session_prompt_queue_attachment_bytes_check check (octet_length(attachments::text) <= 13000000),
  constraint chat_session_prompt_queue_provider_length check (provider_id is null or char_length(provider_id) between 1 and 120),
  constraint chat_session_prompt_queue_model_length check (model_id is null or char_length(model_id) between 1 and 240),
  constraint chat_session_prompt_queue_model_check check ((provider_id is null) = (model_id is null)),
  constraint chat_session_prompt_queue_claim_check check (
    (claim_token is null and claim_expires_at is null)
    or (claim_token ~ '^[A-Za-z0-9_-]{16,128}$' and claim_expires_at is not null)
  )
);

create index if not exists chat_session_prompt_queue_session_order_idx
  on openlink.chat_session_prompt_queue(session_id, user_id, created_at, id);

alter table openlink.chat_session_prompt_queue enable row level security;

drop policy if exists "chat_session_prompt_queue_own" on openlink.chat_session_prompt_queue;
create policy "chat_session_prompt_queue_own"
  on openlink.chat_session_prompt_queue
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table openlink.chat_session_prompt_queue from anon, authenticated;
grant select on table openlink.chat_session_prompt_queue to authenticated;
grant select, insert, update, delete on table openlink.chat_session_prompt_queue to service_role;

create or replace function openlink.enqueue_chat_prompt(
  p_id uuid,
  p_session_id text,
  p_user_id uuid,
  p_message text,
  p_attachments jsonb,
  p_provider_id text default null,
  p_model_id text default null
)
returns setof openlink.chat_session_prompt_queue
language plpgsql
security definer
set search_path = openlink, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat prompt queue owner mismatch' using errcode = '42501';
  end if;
  if (select count(*) from openlink.chat_session_prompt_queue where session_id = p_session_id and user_id = p_user_id) >= 20 then
    raise exception 'chat prompt queue is full' using errcode = 'P0001';
  end if;

  return query
  insert into openlink.chat_session_prompt_queue(id, session_id, user_id, message, attachments, provider_id, model_id)
  values (p_id, p_session_id, p_user_id, p_message, p_attachments, p_provider_id, p_model_id)
  on conflict (id) do nothing
  returning *;

  if not found then
    return query
    select queue.* from openlink.chat_session_prompt_queue as queue
     where queue.id = p_id and queue.session_id = p_session_id and queue.user_id = p_user_id;
  end if;
end;
$$;

create or replace function openlink.claim_next_chat_prompt(
  p_session_id text,
  p_user_id uuid,
  p_claim_token text,
  p_ttl_seconds integer default 120
)
returns setof openlink.chat_session_prompt_queue
language plpgsql
security definer
set search_path = openlink, pg_temp
as $$
declare
  candidate_id uuid;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat prompt queue owner mismatch' using errcode = '42501';
  end if;
  if p_ttl_seconds < 30 or p_ttl_seconds > 600 then
    raise exception 'chat prompt claim ttl is invalid' using errcode = '22023';
  end if;
  if p_claim_token !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'chat prompt claim token is invalid' using errcode = '22023';
  end if;

  select queue.id
    into candidate_id
    from openlink.chat_session_prompt_queue as queue
   where queue.session_id = p_session_id
     and queue.user_id = p_user_id
   order by queue.created_at, queue.id
   for update skip locked
   limit 1;

  if candidate_id is null then return; end if;

  return query
  update openlink.chat_session_prompt_queue as queue
     set claim_token = p_claim_token,
         claim_expires_at = now() + make_interval(secs => p_ttl_seconds),
         updated_at = now()
   where queue.id = candidate_id
     and (queue.claim_token is null or queue.claim_expires_at <= now())
  returning queue.*;
end;
$$;

revoke all on function openlink.claim_next_chat_prompt(text, uuid, text, integer) from public;
revoke all on function openlink.enqueue_chat_prompt(uuid, text, uuid, text, jsonb, text, text) from public;
grant execute on function openlink.claim_next_chat_prompt(text, uuid, text, integer) to authenticated;
grant execute on function openlink.enqueue_chat_prompt(uuid, text, uuid, text, jsonb, text, text) to authenticated;
grant execute on function openlink.claim_next_chat_prompt(text, uuid, text, integer) to service_role;
grant execute on function openlink.enqueue_chat_prompt(uuid, text, uuid, text, jsonb, text, text) to service_role;

create or replace function openlink.finish_chat_prompt_claim(
  p_id uuid,
  p_session_id text,
  p_user_id uuid,
  p_claim_token text,
  p_complete boolean
)
returns boolean
language plpgsql
security definer
set search_path = openlink, pg_temp
as $$
declare
  changed_count integer := 0;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat prompt queue owner mismatch' using errcode = '42501';
  end if;
  if p_complete then
    delete from openlink.chat_session_prompt_queue
     where id = p_id and session_id = p_session_id and user_id = p_user_id and claim_token = p_claim_token;
  else
    update openlink.chat_session_prompt_queue
       set claim_token = null, claim_expires_at = null, updated_at = now()
     where id = p_id and session_id = p_session_id and user_id = p_user_id and claim_token = p_claim_token;
  end if;
  get diagnostics changed_count = row_count;
  return changed_count > 0;
end;
$$;

create or replace function openlink.delete_queued_chat_prompts(
  p_session_id text,
  p_user_id uuid,
  p_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = openlink, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat prompt queue owner mismatch' using errcode = '42501';
  end if;
  delete from openlink.chat_session_prompt_queue
   where session_id = p_session_id
     and user_id = p_user_id
     and (p_id is null or id = p_id)
     and (claim_token is null or claim_expires_at <= now());
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function openlink.finish_chat_prompt_claim(uuid, text, uuid, text, boolean) from public;
revoke all on function openlink.delete_queued_chat_prompts(text, uuid, uuid) from public;
grant execute on function openlink.finish_chat_prompt_claim(uuid, text, uuid, text, boolean) to authenticated, service_role;
grant execute on function openlink.delete_queued_chat_prompts(text, uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
