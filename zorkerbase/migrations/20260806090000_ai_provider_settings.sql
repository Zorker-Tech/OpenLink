create table if not exists openlink.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme text not null default 'system',
  locale text not null default 'zh-CN',
  chat_position text not null default 'left',
  custom_instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_preferences_theme_check check (theme in ('system', 'light', 'dark')),
  constraint user_preferences_locale_check check (locale in ('zh-CN', 'en-US')),
  constraint user_preferences_chat_position_check check (chat_position in ('left', 'right')),
  constraint user_preferences_custom_instructions_length check (char_length(custom_instructions) <= 12000)
);

alter table openlink.user_preferences enable row level security;

drop policy if exists "user_preferences_select_own" on openlink.user_preferences;
create policy "user_preferences_select_own"
  on openlink.user_preferences for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_preferences_insert_own" on openlink.user_preferences;
create policy "user_preferences_insert_own"
  on openlink.user_preferences for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_preferences_update_own" on openlink.user_preferences;
create policy "user_preferences_update_own"
  on openlink.user_preferences for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table openlink.user_preferences from anon, authenticated;
grant select, insert, update on table openlink.user_preferences to authenticated;
grant select, insert, update, delete on table openlink.user_preferences to service_role;

create table if not exists openlink.ai_provider_configurations (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null,
  enabled boolean not null default false,
  is_default boolean not null default false,
  base_url text,
  default_model_id text,
  enabled_model_ids text[] not null default '{}',
  encrypted_api_key text,
  api_key_iv text,
  api_key_tag text,
  api_key_hint text,
  encryption_version smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider_id),
  constraint ai_provider_id_format check (provider_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint ai_provider_base_url_length check (base_url is null or char_length(base_url) <= 2048),
  constraint ai_provider_default_model_length check (default_model_id is null or char_length(default_model_id) <= 256),
  constraint ai_provider_models_count check (cardinality(enabled_model_ids) <= 256),
  constraint ai_provider_secret_shape check (
    (encrypted_api_key is null and api_key_iv is null and api_key_tag is null and api_key_hint is null)
    or
    (encrypted_api_key is not null and api_key_iv is not null and api_key_tag is not null and api_key_hint is not null)
  )
);

create index if not exists ai_provider_configurations_enabled_idx
  on openlink.ai_provider_configurations(user_id, enabled, updated_at desc);

create unique index if not exists ai_provider_configurations_one_default_idx
  on openlink.ai_provider_configurations(user_id)
  where is_default;

alter table openlink.ai_provider_configurations enable row level security;

drop policy if exists "ai_provider_configurations_select_own" on openlink.ai_provider_configurations;
create policy "ai_provider_configurations_select_own"
  on openlink.ai_provider_configurations for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "ai_provider_configurations_insert_own" on openlink.ai_provider_configurations;
create policy "ai_provider_configurations_insert_own"
  on openlink.ai_provider_configurations for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "ai_provider_configurations_update_own" on openlink.ai_provider_configurations;
create policy "ai_provider_configurations_update_own"
  on openlink.ai_provider_configurations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "ai_provider_configurations_delete_own" on openlink.ai_provider_configurations;
create policy "ai_provider_configurations_delete_own"
  on openlink.ai_provider_configurations for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table openlink.ai_provider_configurations from anon, authenticated;
grant select, insert, update, delete on table openlink.ai_provider_configurations to authenticated;
grant select, insert, update, delete on table openlink.ai_provider_configurations to service_role;

notify pgrst, 'reload schema';
