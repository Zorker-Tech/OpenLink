/**
 * Which model an experiment arm puts a turn on.
 *
 * An inactive experiment changes nothing; the control arm gets the experiment's own model, and a treated turn keeps
 * whatever the user chose. Only turns of the sources the experiment covers are moved.
 */
import type { SlateAgentModelSelection } from "../../../shared/agents/slate-agent-model.ts";
import { SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION, type SlateModelExperimentState } from "../../../shared/node/experiments/slate-model-experiment.ts";

function isActiveExperiment(state: SlateModelExperimentState | undefined | null): state is SlateModelExperimentState {
  return state != null && state.active === true;
}

export const SLATE_AUTOMATION_REQUEST_SOURCE = "automation";

function modelForTreatmentTurn(inputs: {
  readonly requestSource?: string | undefined
  readonly readConfiguredDefaultModel: () => SlateAgentModelSelection | undefined
  readonly readConfiguredAutomationsModel: () => SlateAgentModelSelection | undefined
}): SlateAgentModelSelection | undefined {
  if (inputs.requestSource === SLATE_AUTOMATION_REQUEST_SOURCE) {
    const automationModel = inputs.readConfiguredAutomationsModel()
    if (automationModel != null) return automationModel
  }
  return inputs.readConfiguredDefaultModel()
}

export function selectSlateModelExperimentModel(
  state: SlateModelExperimentState | undefined | null,
  configuredModel: SlateAgentModelSelection | undefined,
): SlateAgentModelSelection | undefined {
  if (!isActiveExperiment(state)) return undefined
  return state.arm === "control"
    ? SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION
    : configuredModel ?? SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION
}

export function selectSlateExperimentTurnModel(inputs: {
  readonly state?: SlateModelExperimentState | null | undefined
  readonly requestSource?: string | undefined
  readonly readConfiguredDefaultModel: () => SlateAgentModelSelection | undefined
  readonly readConfiguredAutomationsModel: () => SlateAgentModelSelection | undefined
}): SlateAgentModelSelection | undefined {
  const { state } = inputs
  if (!isActiveExperiment(state)) return undefined
  if (state.arm === "control") return SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION
  return selectSlateModelExperimentModel(state, modelForTreatmentTurn(inputs))
}
