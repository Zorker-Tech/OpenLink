/** Default selection used when an agent request has no model override. */
import type { SlateAgentModelSelection } from "./slate-agent-model.ts";

export const SLATE_DEFAULT_MODEL_ID = "slate-4.5";

const DEFAULT_PARAMETER_PAIRS = [
  ["effort", "high"],
  ["fast", "true"],
] as const;

export const SLATE_DEFAULT_MODEL_SELECTION: SlateAgentModelSelection = {
  modelId: SLATE_DEFAULT_MODEL_ID,
  maxMode: true,
  parameters: DEFAULT_PARAMETER_PAIRS.map(([id, value]) => ({ id, value })),
};
