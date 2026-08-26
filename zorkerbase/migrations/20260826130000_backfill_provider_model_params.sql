-- Models enabled before model params existed (hand-added dynamic models) have
-- no stored parameters, so the context indicator cannot resolve a window and
-- the editor has nothing to show. Backfill every enabled model id that lacks
-- an entry with the same conservative defaults the save path applies
-- (contextWindow 128000, maxTokens 8192, zero cost) — all editable in the UI.
update openlink.ai_provider_configurations
set model_params = model_params || (
  select coalesce(jsonb_object_agg(
    id,
    jsonb_build_object(
      'name', id,
      'reasoning', false,
      'input', '["text"]'::jsonb,
      'contextWindow', 128000,
      'maxTokens', 8192,
      'cost', jsonb_build_object('input', 0, 'output', 0)
    )
  ), '{}'::jsonb)
  from unnest(enabled_model_ids) as id
  where not (model_params ? id)
)
where cardinality(enabled_model_ids) > 0;

notify pgrst, 'reload schema';
