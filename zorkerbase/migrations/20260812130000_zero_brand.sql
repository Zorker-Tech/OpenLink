-- Rename the vector projection's storage identifier to the Zero product name.
-- Keep this migration idempotent so existing local ZOKERBASE databases can be
-- upgraded without losing indexed document metadata.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'openlink' and table_name = 'knowledge_chunks' and column_name = 'milvus_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'openlink' and table_name = 'knowledge_chunks' and column_name = 'zero_id'
  ) then
    alter table openlink.knowledge_chunks rename column milvus_id to zero_id;
  end if;
end
$$;

alter table if exists openlink.knowledge_chunks
  add column if not exists zero_id text;

update openlink.knowledge_chunks
set zero_id = coalesce(nullif(zero_id, ''), document_id::text || ':' || chunk_index::text)
where zero_id is null;

update openlink.knowledge_chunks
set zero_id = document_id::text || ':' || chunk_index::text
where zero_id = '';

alter table openlink.knowledge_chunks
  alter column zero_id set not null;

create unique index if not exists knowledge_chunks_zero_id_unique
  on openlink.knowledge_chunks(zero_id);
