import {
  MAX_MODEL_ID_LENGTH,
  MAX_PARAMETER_VALUE_LENGTH,
  MAX_PARAMETERS,
  ROUTED_MODEL_IDS,
} from "./slate-model-config-constants.ts"
import type { ModelConfigRejection, SlateModelConfigInput, SlateModelConfigResolution } from "./slate-model-config-contracts.ts"

type ParameterSelection = { id: string; value: string }
type RawModelConfig = Record<string, unknown>

function plainRecord(value: unknown): RawModelConfig | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RawModelConfig
    : undefined
}

function parameterSelections(value: unknown): ParameterSelection[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parameters: ParameterSelection[] = []

  for (const item of value) {
    const parameter = plainRecord(item)
    if (parameter === undefined || typeof parameter.id !== "string" || parameter.id.length === 0 || typeof parameter.value !== "string") {
      return undefined
    }
    parameters.push({ id: parameter.id, value: parameter.value })
  }
  return parameters
}

function parameterRejection(parameters: readonly ParameterSelection[]): ModelConfigRejection | undefined {
  if (parameters.length > MAX_PARAMETERS || parameters.some(({ value }) => value.length > MAX_PARAMETER_VALUE_LENGTH)) {
    return "parameters_out_of_bounds"
  }

  const names = new Set<string>()
  for (const parameter of parameters) {
    if (names.has(parameter.id)) return "duplicate_parameter"
    names.add(parameter.id)
  }
  return undefined
}

/** Applies Slate's safety bounds only after the experiment identity is ready to own the setting. */
export function resolveSlateDefaultModelConfig(input: SlateModelConfigInput): SlateModelConfigResolution {
  if (!input.hasHydratedExperimentUser) return { rejection: "identity_unhydrated" }

  const record = plainRecord(input.raw)
  if (record === undefined || typeof record.modelId !== "string" || typeof record.maxMode !== "boolean") {
    return { rejection: "malformed" }
  }
  const parameters = parameterSelections(record.parameters)
  if (parameters === undefined) return { rejection: "malformed" }
  if (record.modelId.length === 0) return {}
  if (record.modelId.length > MAX_MODEL_ID_LENGTH || /[\s\p{Cc}]/u.test(record.modelId)) {
    return { rejection: "invalid_model_id" }
  }

  const invalidParameters = parameterRejection(parameters)
  if (invalidParameters !== undefined) return { rejection: invalidParameters }
  if (ROUTED_MODEL_IDS.has(record.modelId) && (record.maxMode || parameters.length > 0)) {
    return { rejection: "routed_model_parameters" }
  }

  return { selection: { modelId: record.modelId, maxMode: record.maxMode, parameters } }
}
