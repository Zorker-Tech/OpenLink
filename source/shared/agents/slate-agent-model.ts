/** The models the platform's own agents run on, and how a selection of one is recognized. */
export const SLATE_SUMMARIZATION_MODEL_ID = "gemini-2.5-flash";
export const SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID = "claude-opus-4-8";

export interface SlateAgentModelParameter { readonly id: string; readonly value: string; }
export interface SlateAgentModelSelection { readonly modelId: string; readonly maxMode: boolean; readonly parameters: readonly SlateAgentModelParameter[]; }

export const SLATE_COMPUTER_USE_MODEL_SELECTION: SlateAgentModelSelection = {
  modelId: SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID,
  maxMode: false,
  parameters: [{ id: "thinking", value: "false" }, { id: "effort", value: "low" }]
};

export function isSlateAgentModelSelection(value: unknown): value is SlateAgentModelSelection {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.modelId === "string" && record.modelId.length > 0 && typeof record.maxMode === "boolean" && Array.isArray(record.parameters) && record.parameters.every((parameter) => {
    if (typeof parameter !== "object" || parameter == null || Array.isArray(parameter)) return false;
    const item = parameter as Record<string, unknown>;
    return typeof item.id === "string" && item.id.length > 0 && typeof item.value === "string";
  });
}

export function resolveComputerUseModelSelection(args: { readonly storedModel?: SlateAgentModelSelection; readonly overrideModel?: SlateAgentModelSelection }): SlateAgentModelSelection | undefined {
  return args.overrideModel ?? args.storedModel;
}
