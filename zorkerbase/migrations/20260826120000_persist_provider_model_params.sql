-- Persist full per-model metadata so provider additions survive edits and the
-- model editor can override every parameter. Stored as a JSON object keyed by
-- model id: { [modelId]: { name, reasoning, input, contextWindow, maxTokens, cost } }.
-- `enabled_model_ids` still controls which models are active, `default_model_id`
-- the default; this column carries the mutable parameter set for every known
-- model (fetched or hand-added), not just the enabled ones.
alter table openlink.ai_provider_configurations
  add column if not exists model_params jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
