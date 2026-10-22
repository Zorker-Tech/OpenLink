/**
 * The models the platform's own agents run on, and how a selection of one is recognized.
 *
 * A selection names a model, whether that model runs in max mode, and the parameters to hand it. Selections cross a
 * storage boundary, so the guard reads a value one claim at a time instead of trusting a parsed object.
 */
export const SLATE_SUMMARIZATION_MODEL_ID = "gemini-2.5-flash"
export const SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID = "claude-opus-4-8"

export interface SlateAgentModelParameter { readonly id: string; readonly value: string }
export interface SlateAgentModelSelection { readonly modelId: string; readonly maxMode: boolean; readonly parameters: readonly SlateAgentModelParameter[] }

export const SLATE_COMPUTER_USE_MODEL_SELECTION: SlateAgentModelSelection = {
  modelId: SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID,
  maxMode: false,
  parameters: [{ id: "thinking", value: "false" }, { id: "effort", value: "low" }]
}

/** A value that can carry named fields; null and arrays are not records here. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A parameter name is a name: an empty one names nothing. */
const isParameterName = (value: unknown): value is string => typeof value === "string" && value.length > 0

const isModelParameter = (value: unknown): value is SlateAgentModelParameter => isRecord(value) && isParameterName(value.id) && typeof value.value === "string"

/** Whether a stored or received value is a model selection: a named model, its mode, and parameters that read as names. */
export function isSlateAgentModelSelection(value: unknown): value is SlateAgentModelSelection {
  if (!isRecord(value)) return false
  return isParameterName(value.modelId) && typeof value.maxMode === "boolean" && Array.isArray(value.parameters) && value.parameters.every(isModelParameter)
}

/** The model a computer use turn runs on: an explicit choice wins over the stored one. */
export function resolveComputerUseModelSelection(args: { readonly storedModel?: SlateAgentModelSelection; readonly overrideModel?: SlateAgentModelSelection }): SlateAgentModelSelection | undefined {
  return args.overrideModel ?? args.storedModel
}
