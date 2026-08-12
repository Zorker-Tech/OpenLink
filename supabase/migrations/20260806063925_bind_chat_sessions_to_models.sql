alter table openlink.chat_sessions
  add column if not exists provider_id text,
  add column if not exists model_id text;

alter table openlink.chat_sessions
  drop constraint if exists chat_sessions_model_binding_complete,
  add constraint chat_sessions_model_binding_complete check (
    (provider_id is null and model_id is null)
    or (
      provider_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      and char_length(provider_id) <= 96
      and char_length(model_id) between 1 and 256
    )
  );

-- The provider configuration table is created by a later timestamped
-- migration in older OpenLink snapshots. Keep this schema change applicable
-- to a fresh Local database; the follow-up backfill migration runs once the
-- provider table exists.
do $$
begin
  if to_regclass('openlink.ai_provider_configurations') is not null then
    execute $sql$
      with selected_provider as (
        select distinct on (user_id)
          user_id,
          provider_id,
          default_model_id
        from openlink.ai_provider_configurations
        where enabled = true
          and default_model_id is not null
          and default_model_id = any(enabled_model_ids)
        order by user_id, is_default desc, updated_at desc
      )
      update openlink.chat_sessions as session
      set
        provider_id = selected_provider.provider_id,
        model_id = selected_provider.default_model_id
      from selected_provider
      where selected_provider.user_id = session.user_id
        and session.provider_id is null
        and session.model_id is null
    $sql$;
  end if;
end;
$$;

create index if not exists chat_sessions_user_provider_model_idx
  on openlink.chat_sessions(user_id, provider_id, model_id)
  where provider_id is not null and model_id is not null;
