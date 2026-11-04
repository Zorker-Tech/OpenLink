import type { SlateAgentModelSelection } from "../../agents/slate-agent-model.js"

export type ModelConfigRejection =
  | "identity_unhydrated"
  | "malformed"
  | "invalid_model_id"
  | "parameters_out_of_bounds"
  | "duplicate_parameter"
  | "routed_model_parameters"

export interface SlateModelConfigInput {
  readonly raw: unknown
  readonly hasHydratedExperimentUser: boolean
}

export interface SlateModelConfigResolution {
  readonly selection?: SlateAgentModelSelection
  readonly rejection?: ModelConfigRejection
}
