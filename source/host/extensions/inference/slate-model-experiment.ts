/**
 * Which model an experiment arm puts a turn on.
 *
 * An inactive experiment changes nothing; the control arm gets the experiment's own model, and a treated turn keeps
 * whatever the user chose. Only turns of the sources the experiment covers are moved.
 */
import type { SlateAgentModelSelection } from "../../../shared/agents/slate-agent-model.ts";
import { SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION, type SlateModelExperimentState } from "../../../shared/node/experiments/slate-model-experiment.ts";

export function selectSlateModelExperimentModel(state: SlateModelExperimentState | undefined | null, _requestSource: string | undefined, configuredModel: SlateAgentModelSelection | undefined): SlateAgentModelSelection | undefined {
  if (state == null || !state.active) return undefined;
  if (state.arm === "control") return SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION;
  return configuredModel ?? SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION;
}

export const SLATE_AUTOMATION_REQUEST_SOURCE = "automation";
export function selectSlateExperimentTurnModel(inputs: { state?: SlateModelExperimentState | null; requestSource?: string; readConfiguredDefaultModel(): SlateAgentModelSelection | undefined; readConfiguredAutomationsModel(): SlateAgentModelSelection | undefined }): SlateAgentModelSelection | undefined {
  const { state, requestSource } = inputs;
  if (state == null || !state.active || state.arm === "control") return selectSlateModelExperimentModel(state, requestSource, undefined);
  const configured = requestSource === SLATE_AUTOMATION_REQUEST_SOURCE ? inputs.readConfiguredAutomationsModel() ?? inputs.readConfiguredDefaultModel() : inputs.readConfiguredDefaultModel();
  return selectSlateModelExperimentModel(state, requestSource, configured);
}
