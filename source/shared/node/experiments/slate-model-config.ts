/**
 * The model configuration a build reads from its experiment service.
 *
 * A configuration is only read once the identity behind it is known, and everything about it is checked before it is
 * used: the model id is a real id, the parameters are within their bounds, no parameter is named twice, and a routed
 * model — one the platform routes by itself — may not carry parameters of its own. Each refusal is reported as its own
 * reason rather than as one failure.
 */
import type { SlateAgentModelSelection } from "../../agents/slate-agent-model.js";
export const SLATE_DEFAULT_MODEL_CONFIG_NAME = "slate_default_model";
export const SLATE_AUTOMATIONS_MODEL_CONFIG_NAME = "slate_automations_model";
export const SLATE_MODEL_FILTER_CONFIG_NAME = "slate_model_filter";
export const MAX_MODEL_ID_LENGTH = 128; export const MAX_PARAMETERS = 16; export const MAX_PARAMETER_VALUE_LENGTH = 64;
export const ROUTED_MODEL_IDS = new Set(["default", "premium", "auto-low", "auto-medium", "auto-high", "auto-smart"]);
export type ModelConfigRejection = "identity_unhydrated" | "malformed" | "invalid_model_id" | "parameters_out_of_bounds" | "duplicate_parameter" | "routed_model_parameters";
export function resolveSlateDefaultModelConfig(inputs: { raw: unknown; hasHydratedStatsigUserId: boolean }): { selection?: SlateAgentModelSelection; rejection?: ModelConfigRejection } {
  if (!inputs.hasHydratedStatsigUserId) return { rejection: "identity_unhydrated" };
  if (typeof inputs.raw !== "object" || inputs.raw == null || Array.isArray(inputs.raw)) return { rejection: "malformed" };
  const raw = inputs.raw as Record<string, unknown>; if (typeof raw.modelId !== "string" || typeof raw.maxMode !== "boolean" || !Array.isArray(raw.parameters)) return { rejection: "malformed" };
  const parameters: Array<{ id: string; value: string }> = [];
  for (const item of raw.parameters) { if (typeof item !== "object" || item == null || Array.isArray(item)) return { rejection: "malformed" }; const p = item as Record<string, unknown>; if (typeof p.id !== "string" || p.id.length === 0 || typeof p.value !== "string") return { rejection: "malformed" }; parameters.push({ id: p.id, value: p.value }); }
  if (raw.modelId.length === 0) return {};
  if (raw.modelId.length > MAX_MODEL_ID_LENGTH || /[\s\p{Cc}]/u.test(raw.modelId)) return { rejection: "invalid_model_id" };
  if (parameters.length > MAX_PARAMETERS || parameters.some((p) => p.value.length > MAX_PARAMETER_VALUE_LENGTH)) return { rejection: "parameters_out_of_bounds" };
  const ids = new Set<string>(); for (const parameter of parameters) { if (ids.has(parameter.id)) return { rejection: "duplicate_parameter" }; ids.add(parameter.id); }
  if (ROUTED_MODEL_IDS.has(raw.modelId) && (raw.maxMode || parameters.length > 0)) return { rejection: "routed_model_parameters" };
  return { selection: { modelId: raw.modelId, maxMode: raw.maxMode, parameters } };
}
