-- Embedding credentials deliberately live separately from chat-provider
-- credentials: they drive the shared Knowledge/Zero index and are never
-- exposed to Project VMs or browser clients.
create table if not exists openlink.embedding_provider_configurations (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null,
  enabled boolean not null default false,
  is_default boolean not null default false,
  base_url text,
  protocol text not null default 'openai',
  default_model_id text not null,
  vector_dimension integer not null,
  encrypted_api_key text,
  api_key_iv text,
  api_key_tag text,
  api_key_hint text,
  encryption_version smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider_id),
  constraint embedding_provider_id_format check (provider_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint embedding_provider_protocol_check check (protocol in ('openai', 'ollama', 'tei')),
  constraint embedding_provider_base_url_length check (base_url is null or char_length(base_url) <= 2048),
  constraint embedding_provider_model_length check (char_length(default_model_id) between 1 and 256),
  constraint embedding_provider_dimension_check check (vector_dimension between 2 and 32768),
  constraint embedding_provider_secret_shape check (
    (encrypted_api_key is null and api_key_iv is null and api_key_tag is null and api_key_hint is null)
    or (encrypted_api_key is not null and api_key_iv is not null and api_key_tag is not null and api_key_hint is not null)
  )
);

create index if not exists embedding_provider_configurations_enabled_idx
  on openlink.embedding_provider_configurations(user_id, enabled, updated_at desc);
create unique index if not exists embedding_provider_configurations_one_default_idx
  on openlink.embedding_provider_configurations(user_id) where is_default;

alter table openlink.embedding_provider_configurations enable row level security;

drop policy if exists embedding_provider_configurations_select_own on openlink.embedding_provider_configurations;
create policy embedding_provider_configurations_select_own on openlink.embedding_provider_configurations
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists embedding_provider_configurations_insert_own on openlink.embedding_provider_configurations;
create policy embedding_provider_configurations_insert_own on openlink.embedding_provider_configurations
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists embedding_provider_configurations_update_own on openlink.embedding_provider_configurations;
create policy embedding_provider_configurations_update_own on openlink.embedding_provider_configurations
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists embedding_provider_configurations_delete_own on openlink.embedding_provider_configurations;
create policy embedding_provider_configurations_delete_own on openlink.embedding_provider_configurations
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on table openlink.embedding_provider_configurations from anon, authenticated;
grant select, insert, update, delete on table openlink.embedding_provider_configurations to authenticated;
grant select, insert, update, delete on table openlink.embedding_provider_configurations to service_role;

notify pgrst, 'reload schema';
