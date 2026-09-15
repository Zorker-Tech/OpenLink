-- Keep binary prompt uploads out of canonical chat events and the durable
-- follow-up queue. Events retain stable metadata while this owner-scoped table
-- holds the bounded payload until the Agent Worker stages it in the Project VM.
create table if not exists openlink.chat_session_uploads (
  id uuid primary key,
  batch_id uuid not null,
  session_id text not null,
  user_id uuid not null,
  filename text not null,
  relative_path text,
  media_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  content_base64 text not null,
  created_at timestamptz not null default now(),
  constraint chat_session_uploads_owner_fkey
    foreign key (session_id, user_id)
    references openlink.chat_sessions(id, user_id)
    on delete cascade,
  constraint chat_session_uploads_filename_check check (
    char_length(filename) between 1 and 240
    and filename not in ('.', '..')
    and filename !~ '[/\\[:cntrl:]]'
  ),
  constraint chat_session_uploads_relative_path_check check (
    relative_path is null
    or (
      char_length(relative_path) between 1 and 1024
      and relative_path !~ '(^/|\\|//|(^|/)\.\.?(/|$)|[[:cntrl:]])'
    )
  ),
  constraint chat_session_uploads_media_type_check check (
    char_length(media_type) between 1 and 160 and media_type !~ '[[:cntrl:]]'
  ),
  constraint chat_session_uploads_size_check check (size_bytes between 0 and 2097152),
  constraint chat_session_uploads_sha256_check check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint chat_session_uploads_base64_check check (
    char_length(content_base64) <= 2796204
    and content_base64 ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    and octet_length(decode(content_base64, 'base64')) = size_bytes
  )
);

create index if not exists chat_session_uploads_session_idx
  on openlink.chat_session_uploads(session_id, user_id, created_at, id);

alter table openlink.chat_session_uploads enable row level security;

drop policy if exists "chat_session_uploads_own" on openlink.chat_session_uploads;
create policy "chat_session_uploads_own"
  on openlink.chat_session_uploads
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table openlink.chat_session_uploads from anon, authenticated;
grant select, insert, delete on table openlink.chat_session_uploads to service_role;

create or replace function openlink.register_chat_session_upload(
  p_id uuid,
  p_batch_id uuid,
  p_session_id text,
  p_user_id uuid,
  p_filename text,
  p_relative_path text,
  p_media_type text,
  p_size_bytes integer,
  p_sha256 text,
  p_content_base64 text
)
returns setof openlink.chat_session_uploads
language plpgsql
security definer
set search_path = openlink, pg_temp
as $$
declare
  existing openlink.chat_session_uploads%rowtype;
  upload_count integer;
  upload_bytes bigint;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat upload owner mismatch' using errcode = '42501';
  end if;
  if not exists (
    select 1 from openlink.chat_sessions
     where id = p_session_id and user_id = p_user_id
  ) then
    raise exception 'chat session does not exist' using errcode = '23503';
  end if;

  select * into existing from openlink.chat_session_uploads where id = p_id;
  if found then
    if existing.session_id <> p_session_id or existing.user_id <> p_user_id
      or existing.batch_id <> p_batch_id or existing.filename <> p_filename
      or existing.relative_path is distinct from p_relative_path
      or existing.media_type <> p_media_type or existing.size_bytes <> p_size_bytes
      or existing.sha256 <> p_sha256 or existing.content_base64 <> p_content_base64 then
      raise exception 'chat upload id conflict' using errcode = '23505';
    end if;
    return next existing;
    return;
  end if;

  select count(*), coalesce(sum(size_bytes), 0)
    into upload_count, upload_bytes
    from openlink.chat_session_uploads
   where session_id = p_session_id and user_id = p_user_id;
  if upload_count >= 256 or upload_bytes + p_size_bytes > 268435456 then
    raise exception 'chat upload quota exceeded' using errcode = 'P0001';
  end if;

  return query
  insert into openlink.chat_session_uploads(
    id, batch_id, session_id, user_id, filename, relative_path,
    media_type, size_bytes, sha256, content_base64
  ) values (
    p_id, p_batch_id, p_session_id, p_user_id, p_filename, p_relative_path,
    p_media_type, p_size_bytes, p_sha256, p_content_base64
  )
  returning *;
end;
$$;

create or replace function openlink.resolve_chat_session_uploads(
  p_session_id text,
  p_user_id uuid,
  p_ids uuid[]
)
returns setof openlink.chat_session_uploads
language plpgsql
security definer
set search_path = openlink, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat upload owner mismatch' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) > 24 then
    raise exception 'too many chat uploads' using errcode = '22023';
  end if;
  return query
  select upload.*
    from openlink.chat_session_uploads as upload
   where upload.session_id = p_session_id
     and upload.user_id = p_user_id
     and upload.id = any(p_ids)
   order by array_position(p_ids, upload.id);
end;
$$;

create or replace function openlink.delete_chat_session_uploads(
  p_session_id text,
  p_user_id uuid,
  p_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = openlink, pg_temp
as $$
declare
  deleted_count integer;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'chat upload owner mismatch' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) > 24 then
    raise exception 'too many chat uploads' using errcode = '22023';
  end if;
  delete from openlink.chat_session_uploads
   where session_id = p_session_id and user_id = p_user_id and id = any(p_ids);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function openlink.register_chat_session_upload(uuid, uuid, text, uuid, text, text, text, integer, text, text) from public;
revoke all on function openlink.resolve_chat_session_uploads(text, uuid, uuid[]) from public;
revoke all on function openlink.delete_chat_session_uploads(text, uuid, uuid[]) from public;
grant execute on function openlink.register_chat_session_upload(uuid, uuid, text, uuid, text, text, text, integer, text, text) to authenticated, service_role;
grant execute on function openlink.resolve_chat_session_uploads(text, uuid, uuid[]) to authenticated, service_role;
grant execute on function openlink.delete_chat_session_uploads(text, uuid, uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
