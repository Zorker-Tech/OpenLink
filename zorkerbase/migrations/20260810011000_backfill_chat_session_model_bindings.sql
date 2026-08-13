-- Complete model binding after provider settings are present. This is also
-- safe for Cloud deployments where the earlier migration already ran.
do $$
begin
  if to_regclass('openlink.chat_sessions') is not null
    and to_regclass('openlink.ai_provider_configurations') is not null then
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
