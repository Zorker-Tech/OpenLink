/** The model an agent runs on when nobody chose one. */
import type { SlateAgentModelSelection } from "./slate-agent-model.ts";

export const SLATE_DEFAULT_MODEL_ID = "slate-4.5";

export const SLATE_DEFAULT_MODEL_SELECTION: SlateAgentModelSelection = {
  modelId: SLATE_DEFAULT_MODEL_ID,
  maxMode: true,
  parameters: [
    { id: "effort", value: "high" },
    { id: "fast", value: "true" },
  ],
};
